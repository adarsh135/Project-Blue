import { api, streamChat } from './api.js';
import { renderInto, escapeHtml } from './markdown.js';
import { state, emit, currentSession } from './store.js';
import { $, clear, el, toast, toolIcon, providerLabel } from './ui.js';

const messagesInner = () => $('#messages-inner');
let pendingAttachments = [];

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sql', '.html', '.htm', '.css', '.xml', '.yaml', '.yml', '.toml', '.sh', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.rb', '.php']);
const MIME_BY_EXTENSION = { '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json', '.md': 'text/markdown', '.html': 'text/html', '.htm': 'text/html', '.js': 'text/javascript', '.ts': 'text/typescript', '.py': 'text/x-python', '.sql': 'text/plain', '.txt': 'text/plain', '.log': 'text/plain' };

function queueAttachment(attachment) {
  const textChars = pendingAttachments.reduce((sum, item) => sum + (item.kind === 'text' ? item.text.length : 0), 0) +
    (attachment.kind === 'text' ? attachment.text.length : 0);
  if (textChars > 800_000) {
    toast('Combined text attachments must be under 800,000 characters.', 'err');
    return false;
  }
  const payloadBytes = new Blob([JSON.stringify([...pendingAttachments, attachment])]).size;
  if (payloadBytes > 3_500_000) {
    toast('Combined attachment payload is too large; remove a file and try again.', 'err');
    return false;
  }
  pendingAttachments.push(attachment);
  return true;
}

export function clearPendingAttachments() {
  pendingAttachments = [];
  renderPendingAttachments();
  const input = $('#attachment-input');
  if (input) input.value = '';
}

export async function addFiles(files) {
  for (const file of files) {
    if (pendingAttachments.length >= 3) {
      toast('Attach at most 3 files per message.', 'err');
      break;
    }
    const name = String(file.name || 'attachment').slice(0, 128);
    const dot = name.toLowerCase().lastIndexOf('.');
    const extension = dot < 0 ? '' : name.toLowerCase().slice(dot);
    const mimeType = file.type || MIME_BY_EXTENSION[extension] || 'application/octet-stream';
    const isText = mimeType.startsWith('text/') || mimeType === 'application/json' || TEXT_EXTENSIONS.has(extension);
    const maxBytes = isText ? 600_000 : state.limits?.maxAttachmentBytes || 2 * 1024 * 1024;
    if (file.size > maxBytes) {
      toast(`${name} is too large (limit ${Math.ceil(maxBytes / 1024 / 1024)} MB).`, 'err');
      continue;
    }

    try {
      if (isText) {
        const text = await file.text();
        queueAttachment({ name, mimeType, kind: 'text', text, size: file.size });
      } else if (['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/mp4', 'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf'].includes(mimeType)) {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Could not read file'));
          reader.readAsDataURL(file);
        });
        const binaryBytes = pendingAttachments.filter((item) => item.kind !== 'text').reduce((sum, item) => sum + (item.size || 0), 0);
        if (binaryBytes + file.size > 2_600_000) {
          toast('Combined image/audio/video/PDF files must be under 2.6 MB per message.', 'err');
          continue;
        }
        queueAttachment({ name, mimeType, kind: mimeType.startsWith('image/') ? 'image' : 'media', data, size: file.size });
      } else {
        toast(`${name} has an unsupported file type.`, 'err');
      }
    } catch (error) {
      toast(`${name}: ${error.message || 'could not read file'}`, 'err');
    }
  }
  renderPendingAttachments();
}

function iconForAttachment(attachment) {
  if (attachment.kind === 'image' || attachment.mimeType?.startsWith('image/')) return '🖼';
  if (attachment.mimeType?.startsWith('audio/')) return '🎧';
  if (attachment.mimeType?.startsWith('video/')) return '🎬';
  if (attachment.mimeType === 'application/pdf') return '📕';
  return String(attachment.name || '').toLowerCase().endsWith('.csv') ? '📊' : '📄';
}

function renderPendingAttachments() {
  const list = clear($('#attachment-list'));
  for (const [index, attachment] of pendingAttachments.entries()) {
    list.append(el('span', { class: 'attachment-chip' }, [
      iconForAttachment(attachment),
      el('span', { class: 'filename', title: attachment.name, text: attachment.name }),
      el('button', { type: 'button', title: 'Remove attachment', 'aria-label': `Remove ${attachment.name}`, text: '×', onclick: () => {
        pendingAttachments.splice(index, 1);
        renderPendingAttachments();
      } }),
    ]));
  }
}

function renderMessageAttachments(container, attachments = []) {
  if (!attachments?.length) return;
  const list = el('div', { class: 'msg-attachments' });
  for (const attachment of attachments) {
    list.append(el('span', { class: 'attachment-chip', title: attachment.mimeType || '' }, [
      iconForAttachment(attachment),
      el('span', { class: 'filename', text: attachment.name || 'attachment' }),
    ]));
  }
  container.append(list);
}

const scrollToBottom = (force = false) => {
  const box = $('#messages');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 260;
  if (force || nearBottom) box.scrollTop = box.scrollHeight;
};

/* ------------------------------------------------------------------ */
/* message rendering                                                   */
/* ------------------------------------------------------------------ */

/**
 * Build a message shell. A user message owns a single `.msg-body`; an
 * assistant message starts empty and gains one `.msg-body` block per text
 * segment (with tool cards in between), which is how real agent transcripts
 * read.
 */
export function messageNode(role) {
  const bubble = el('div', { class: 'bubble' }, [
    el('div', { class: 'role' }, [role === 'user' ? 'You' : 'Blue']),
  ]);
  const node = el('div', { class: `msg ${role}` }, [
    el('div', { class: 'gutter' }, [
      el('span', { html: role === 'user' ? avatarSvg(state.user) : blueMark(), style: 'font-size:16px' }),
    ]),
    bubble,
  ]);
  let body = null;
  if (role === 'user') {
    body = el('div', { class: 'msg-body md' });
    bubble.append(body);
  }
  return { node, body, bubble };
}

function avatarSvg(user) {
  const label = (user?.name || user?.email || '?').trim().slice(0, 1).toUpperCase();
  return escapeHtml(label);
}

const blueMark = () => '<span style="color:var(--accent-2)">◈</span>';

function toolCard({ id, name, args = {}, status = 'running', summary = '', payload = null }) {
  const argText = typeof args === 'string' ? args : JSON.stringify(args);
  const head = el('div', { class: 'tool-head' }, [
    el('span', { text: toolIcon(name) }),
    el('span', { class: 'name', text: name }),
    el('span', { class: 'args', text: argText.length > 90 ? `${argText.slice(0, 90)}…` : argText }),
    el('span', { class: 'sp' }, [
      status === 'running'
        ? el('span', { class: 'spinner' })
        : el('span', { class: `pill ${status === 'ok' ? 'pill-ok' : 'pill-err'}`, text: status === 'ok' ? 'done' : 'failed' }),
    ]),
  ]);
  const body = el('div', { class: 'tool-body' });
  const card = el('div', { class: 'tool-card', 'data-tool-id': id }, [head, body]);
  head.addEventListener('click', () => card.classList.toggle('open'));
  fillToolBody(body, name, payload, summary, status);
  return card;
}

function fillToolBody(body, name, payload, summary, status) {
  clear(body);
  if (status === 'running') {
    body.append(el('div', { class: 'muted small', text: summary || 'running…' }));
    return;
  }
  if (!payload) {
    body.append(el('div', { class: 'muted small', text: summary || 'no output' }));
    return;
  }
  if (payload.ok === false) {
    body.append(el('div', { class: 'small', style: 'color:var(--err)', text: payload.error || 'failed' }));
    return;
  }
  if ((name === 'web_search' && payload.results) || (name === 'deep_research' && payload.sources)) {
    const list = el('div', { class: 'result-list' });
    if (payload.answer) list.append(el('div', { class: 'small muted', text: payload.answer }));
    const results = name === 'deep_research' ? payload.sources : payload.results;
    for (const [index, result] of results.entries()) {
      list.append(
        el('a', { class: 'result', href: result.url, target: '_blank', rel: 'noopener noreferrer' }, [
          el('b', { text: `${index + 1}. ${result.title || result.url}` }),
          el('span', { text: result.snippet || '' }),
          el('code', { text: result.url }),
        ]),
      );
    }
    body.append(list);
    return;
  }
  if (name === 'data_analysis' && payload.columns) {
    body.append(el('div', { class: 'small muted', text: `${payload.row_count} rows · ${payload.file_name}` }));
    const table = el('table', { class: 'table' });
    table.append(el('thead', {}, [el('tr', {}, ['Column', 'Type', 'Missing', 'Min', 'Max', 'Mean'].map((label) => el('th', { text: label })))]));
    const tbody = el('tbody');
    for (const column of payload.columns) {
      tbody.append(el('tr', {}, [
        el('td', { text: column.name }), el('td', { text: column.type }), el('td', { text: String(column.missing) }),
        el('td', { text: column.min === undefined ? '—' : String(column.min) }),
        el('td', { text: column.max === undefined ? '—' : String(column.max) }),
        el('td', { text: column.mean === undefined ? '—' : String(column.mean) }),
      ]));
    }
    table.append(tbody);
    body.append(table);
    if (payload.chart?.series?.length) {
      const chart = el('div', { class: 'csv-chart', role: 'img', 'aria-label': `Grouped ${payload.chart.operation} by ${payload.chart.group_by}` });
      const max = Math.max(...payload.chart.series.map((item) => Number(item.value) || 0), 1);
      for (const item of payload.chart.series) {
        const row = el('div', { class: 'csv-bar-row' }, [
          el('span', { class: 'csv-bar-label', title: item.label, text: item.label }),
          el('span', { class: 'csv-bar-track' }, [el('span', { class: 'csv-bar-fill', style: `width:${Math.max(2, (Number(item.value) / max) * 100)}%` })]),
          el('span', { class: 'csv-bar-value', text: String(item.value) }),
        ]);
        chart.append(row);
      }
      body.append(chart);
    }
    return;
  }
  const text = payload.text || payload.formatted || payload.result || payload.excerpt;
  body.append(
    el('pre', {
      class: 'mono',
      text: text ? String(text).slice(0, 4000) : JSON.stringify(payload, null, 2).slice(0, 4000),
      style: 'white-space:pre-wrap;color:var(--muted)',
    }),
  );
}

export function renderHistory(messages) {
  const inner = clear(messagesInner());
  if (!messages.length) {
    inner.append(welcomeNode());
    return;
  }
  const toolResults = new Map();
  for (const row of messages) if (row.role === 'tool') toolResults.set(row.tool_call_id || row.id, row);

  for (const row of messages) {
    if (row.role === 'tool') continue;
    const { node, body, bubble } = messageNode(row.role === 'user' ? 'user' : 'assistant');
    if (row.role === 'assistant') {
      const parts = [];
      if (row.content) parts.push({ kind: 'text', value: row.content });
      for (const call of row.tool_calls || []) {
        const result = toolResults.get(call.id);
        let payload = null;
        try {
          payload = result ? JSON.parse(result.content) : null;
        } catch {
          payload = null;
        }
        parts.push({ kind: 'tool', call, payload });
      }
      for (const part of parts) {
        if (part.kind === 'text') {
          const block = el('div', { class: 'msg-body md' });
          renderInto(block, part.value);
          bubble.append(block);
        } else {
          bubble.append(
            toolCard({
              id: part.call.id,
              name: part.call.name,
              args: part.call.args,
              status: part.payload ? (part.payload.ok ? 'ok' : 'err') : 'ok',
              summary: part.payload?.summary || '',
              payload: part.payload,
            }),
          );
        }
      }
      if (!parts.length) continue;
    } else {
      renderMessageAttachments(bubble, row.attachments);
      renderInto(body, row.content);
    }
    addMessageActions(node, row);
    inner.append(node);
  }
  scrollToBottom(true);
}

function addMessageActions(node, row) {
  const bubble = node.querySelector('.bubble');
  const actions = el('div', { class: 'msg-actions' });
  actions.append(el('button', { text: '⧉ Copy', onclick: () => navigator.clipboard.writeText(row.content || '') }));
  if (row.role === 'assistant' && row.content) {
    actions.append(
      el('button', {
        text: '↻ Regenerate',
        onclick: () => {
          const rows = state.messages.filter((m) => m.role !== 'tool');
          const index = rows.findIndex((m) => m.id === row.id);
          const previous = [...rows.slice(0, index)].reverse().find((m) => m.role === 'user');
          if (previous) sendTurn(previous.content);
        },
      }),
    );
    if (window.speechSynthesis && (window.SpeechSynthesisUtterance || globalThis.SpeechSynthesisUtterance)) {
      actions.append(el('button', {
        text: '🔊 Read aloud',
        onclick: () => {
          window.speechSynthesis.cancel();
          const Utterance = window.SpeechSynthesisUtterance || globalThis.SpeechSynthesisUtterance;
          window.speechSynthesis.speak(new Utterance(String(row.content).replace(/[`*_#>]/g, ' ')));
        },
      }));
    }
  }
  if (row.latency_ms) {
    actions.append(el('span', { class: 'muted small', text: `${row.latency_ms} ms · ${row.model || ''}` }));
  }
  bubble.append(actions);
}

export function welcomeNode() {
  const node = el('div', { class: 'hero-empty', id: 'welcome' }, [
    el('div', { style: 'font-size:34px', text: '◈' }),
    el('h2', { style: 'margin:12px 0 6px;font-size:24px;letter-spacing:-0.02em' }, [
      'Hello, ',
      el('span', { id: 'welcome-name', text: (state.user?.name || 'there').split(' ')[0] }),
      '.',
    ]),
    el('p', {
      class: 'muted',
      style: 'max-width:56ch;margin:0 auto;line-height:1.7',
      html: "I'm <b>Blue</b> — an agentic assistant running on this server. I can search the web, read pages, do maths, remember facts about you, and dig through your earlier chats and searches.",
    }),
  ]);
  const suggestions = el('div', { class: 'suggestions', style: 'justify-content:center;margin-top:22px' });
  for (const text of [
    'search for the latest Node.js LTS release',
    'remember my timezone is Asia/Kolkata',
    'show my recent searches',
    'what can I ask you to do?',
    'calc (1250 * 1.18) / 3',
  ]) {
    suggestions.append(el('button', { class: 'suggestion', text, onclick: () => sendTurn(text) }));
  }
  node.append(suggestions);
  return node;
}

/* ------------------------------------------------------------------ */
/* sending a turn                                                      */
/* ------------------------------------------------------------------ */

let controller = null;

export function stopStreaming() {
  controller?.abort();
  controller = null;
}

export async function ensureSession() {
  if (state.currentSessionId) return state.currentSessionId;
  const { session } = await api('/api/sessions', { method: 'POST', body: { title: 'New chat' } });
  state.sessions.unshift(session);
  state.currentSessionId = session.id;
  emit('sessions');
  return session.id;
}

export async function sendTurn(text) {
  let content = String(text || '').trim();
  if (state.streaming) return;
  const attachments = [...pendingAttachments];
  if (!content && !attachments.length) return;
  if (!content) content = `Please analyze the attached file${attachments.length === 1 ? '' : 's'}: ${attachments.map((file) => file.name).join(', ')}`;

  const input = $('#input');
  if (input) {
    input.value = '';
    input.style.height = 'auto';
  }
  pendingAttachments = [];
  renderPendingAttachments();
  const publicAttachments = attachments.map(({ name, mimeType, kind, size }) => ({ name, mimeType, kind, size }));

  const inner = messagesInner();
  $('#welcome')?.remove();

  // optimistic user bubble
  const { node: userNode, body: userBody, bubble: userBubble } = messageNode('user');
  renderMessageAttachments(userBubble, publicAttachments);
  renderInto(userBody, content);
  inner.append(userNode);
  state.messages.push({ id: `local_${Date.now()}`, role: 'user', content, attachments: publicAttachments, created_at: new Date().toISOString() });
  scrollToBottom(true);

  state.streaming = true;
  emit('streaming');
  controller = new AbortController();

  const { node: assistantNode, bubble } = messageNode('assistant');
  const typing = el('div', { class: 'typing' }, [el('i'), el('i'), el('i')]);
  bubble.append(typing);
  inner.append(assistantNode);
  scrollToBottom(true);

  let activeBlock = null;
  let buffer = '';
  let failed = false;
  const toolNodes = new Map();

  const startBlock = () => {
    activeBlock = el('div', { class: 'msg-body md cursor' });
    bubble.insertBefore(activeBlock, typing);
    return activeBlock;
  };

  try {
    const sessionId = await ensureSession();
    await streamChat(
      sessionId,
      { content, attachments, mode: state.settings?.mode || 'auto' },
      {
        signal: controller.signal,
        onEvent: (event) => {
          switch (event.type) {
            case 'start': {
              const sub = $('#topbar-sub');
              if (sub) sub.textContent = `${providerLabel(event.provider)} · ${event.model}`;
              if (event.title) {
                const session = currentSession();
                if (session) session.title = event.title;
                $('#topbar-title').textContent = event.title;
                emit('sessions');
              }
              break;
            }
            case 'text': {
              typing.remove();
              if (!activeBlock) startBlock();
              buffer += event.delta;
              renderInto(activeBlock, buffer);
              scrollToBottom();
              break;
            }
            case 'tool_start': {
              typing.remove();
              if (activeBlock) activeBlock.classList.remove('cursor');
              activeBlock = null;
              const card = toolCard({ id: event.id, name: event.name, args: event.args, status: 'running' });
              card.classList.add('open');
              toolNodes.set(event.id, card);
              bubble.insertBefore(card, typing);
              scrollToBottom();
              break;
            }
            case 'tool_result': {
              const card = toolNodes.get(event.id);
              if (card) {
                const head = card.querySelector('.tool-head');
                head.querySelector('.sp').innerHTML = '';
                head
                  .querySelector('.sp')
                  .append(
                    el('span', {
                      class: `pill ${event.ok ? 'pill-ok' : 'pill-err'}`,
                      text: event.ok ? 'done' : 'failed',
                    }),
                  );
                fillToolBody(card.querySelector('.tool-body'), event.name, event.payload, event.summary, event.ok ? 'ok' : 'err');
              }
              emit('searches-dirty');
              scrollToBottom();
              break;
            }
            case 'error': {
              failed = true;
              const errorBlock = el('div', {
                class: 'msg-body md',
                style: 'color:var(--err)',
                html: `⚠️ ${escapeHtml(event.message)}`,
              });
              bubble.insertBefore(errorBlock, typing);
              break;
            }
            case 'done': {
              const sub = $('#topbar-sub');
              if (sub) {
                sub.textContent = `${providerLabel(event.provider)} · ${event.model} · ${event.latencyMs} ms · ${event.tokensIn}+${event.tokensOut} tok`;
              }
              break;
            }
            default:
              break;
          }
        },
      },
    );
  } catch (error) {
    failed = true;
    if (error.name !== 'AbortError' && attachments.length) {
      pendingAttachments = attachments;
      renderPendingAttachments();
    }
    if (error.name !== 'AbortError') {
      typing.remove();
      bubble.append(
        el('div', {
          class: 'msg-body md',
          style: 'color:var(--err)',
          html: `⚠️ ${escapeHtml(error.message || 'Something went wrong')}`,
        }),
      );
      toast(error.message || 'Request failed', 'err');
    }
  } finally {
    typing.remove();
    if (activeBlock) activeBlock.classList.remove('cursor');
    if (!bubble.querySelector('.msg-body') && !failed) {
      bubble.append(el('div', { class: 'msg-body md muted', text: '(no output)' }));
    }
    state.streaming = false;
    controller = null;
    emit('streaming');
    emit('sessions-dirty');
    emit('searches-dirty');
    scrollToBottom(true);
    await reloadConversation(sessionIdSafe(), { silent: true });
  }
}

const sessionIdSafe = () => state.currentSessionId;

export async function reloadConversation(sessionId = state.currentSessionId, { silent = false } = {}) {
  if (!sessionId) return;
  try {
    const data = await api(`/api/sessions/${encodeURIComponent(sessionId)}`);
    state.messages = data.messages;
    if (!silent) renderHistory(data.messages);
    else renderHistory(data.messages);
  } catch (error) {
    if (!silent) toast(error.message, 'err');
  }
}
