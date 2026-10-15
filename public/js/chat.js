import { api, streamChat } from './api.js';
import { renderInto, escapeHtml } from './markdown.js';
import { state, emit, currentSession } from './store.js';
import { $, clear, el, toast, toolIcon, providerLabel } from './ui.js';

const messagesInner = () => $('#messages-inner');
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
  if (name === 'web_search' && payload.results) {
    const list = el('div', { class: 'result-list' });
    if (payload.answer) list.append(el('div', { class: 'small muted', text: payload.answer }));
    for (const [index, r] of payload.results.entries()) {
      list.append(
        el('a', { class: 'result', href: r.url, target: '_blank', rel: 'noopener noreferrer' }, [
          el('b', { text: `${index + 1}. ${r.title || r.url}` }),
          el('span', { text: r.snippet || '' }),
          el('code', { text: r.url }),
        ]),
      );
    }
    body.append(list);
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
  const content = String(text || '').trim();
  if (!content || state.streaming) return;

  const input = $('#input');
  if (input) {
    input.value = '';
    input.style.height = 'auto';
  }

  const inner = messagesInner();
  $('#welcome')?.remove();

  // optimistic user bubble
  const { node: userNode, body: userBody } = messageNode('user');
  renderInto(userBody, content);
  inner.append(userNode);
  state.messages.push({ id: `local_${Date.now()}`, role: 'user', content, created_at: new Date().toISOString() });
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
      { content },
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
