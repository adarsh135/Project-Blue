import { api } from './api.js';
import { state, emit, currentSession } from './store.js';
import {
  $,
  clear,
  confirmAction,
  copyText,
  dayLabel,
  el,
  initials,
  modal,
  shortDate,
  timeAgo,
  toast,
  toolIcon,
} from './ui.js';

/* ------------------------------------------------------------------ */
/* loaders                                                             */
/* ------------------------------------------------------------------ */

export async function loadProviders() {
  const data = await api('/api/providers');
  state.providers = data.providers || [];
  state.limits = data.limits || null;
  state.version = data.version || state.version;
  const pill = $('#version-pill');
  if (pill) pill.textContent = state.version;
  return state.providers;
}

export async function loadSessions() {
  const { sessions } = await api('/api/sessions');
  state.sessions = sessions;
  emit('sessions');
  return sessions;
}

export async function loadSearches() {
  const params = new URLSearchParams({ limit: '60' });
  if (state.searchFilter) params.set('q', state.searchFilter);
  if (state.pinnedOnly) params.set('pinned', '1');
  const data = await api(`/api/searches?${params}`);
  state.searches = data.searches || [];
  $('#count-searches').textContent = state.searches.length;
  emit('searches');
  return state.searches;
}

export async function loadMemories() {
  const { memories } = await api('/api/memories');
  state.memories = memories;
  $('#count-memories').textContent = memories.length;
  emit('memories');
  return memories;
}

export async function loadTools() {
  const { tools } = await api('/api/tools');
  state.tools = tools;
  emit('tools');
  return tools;
}

export async function loadStats() {
  state.stats = await api('/api/stats');
  return state.stats;
}

export async function loadApiKeys() {
  const { keys } = await api('/api/auth/keys');
  state.apiKeys = keys;
  return keys;
}

export async function loadDeviceSessions() {
  const { sessions } = await api('/api/auth/sessions');
  state.deviceSessions = sessions;
  return sessions;
}

export async function loadAuthEvents() {
  const { events } = await api('/api/auth/events');
  state.authEvents = events;
  return events;
}

/* ------------------------------------------------------------------ */
/* sidebar: conversations                                              */
/* ------------------------------------------------------------------ */

export function renderConversationList() {
  const list = clear($('#conv-list'));
  const filter = state.conversationFilter.toLowerCase();
  const sessions = state.sessions.filter((s) => !filter || s.title.toLowerCase().includes(filter));
  if (!sessions.length) {
    list.append(el('div', { class: 'empty small', text: filter ? 'No conversations match that filter.' : 'No conversations yet — say hello.' }));
    return;
  }
  for (const session of sessions) {
    const item = el('div', { class: `conv-item ${session.id === state.currentSessionId ? 'active' : ''}` }, [
      el('span', { class: 't' }, [session.pinned ? el('span', { text: '📌' }) : null, session.title]),
      el('span', { class: 'm', text: `${session.message_count || 0} messages · ${timeAgo(session.updated_at)}` }),
      el('button', {
        class: 'x',
        text: '✕',
        title: 'Delete chat',
        onclick: async (event) => {
          event.stopPropagation();
          const ok = await confirmAction({
            title: 'Delete this conversation?',
            description: `"${session.title}" and its messages will be removed permanently.`,
            confirmLabel: 'Delete',
          });
          if (!ok) return;
          await api(`/api/sessions/${session.id}`, { method: 'DELETE' });
          state.sessions = state.sessions.filter((s) => s.id !== session.id);
          if (state.currentSessionId === session.id) {
            state.currentSessionId = null;
            state.messages = [];
            emit('open-session', null);
          }
          emit('sessions');
          toast('Conversation deleted');
        },
      }),
    ]);
    item.addEventListener('click', () => emit('open-session', session.id));
    item.addEventListener('contextmenu', async (event) => {
      event.preventDefault();
      await api(`/api/sessions/${session.id}`, { method: 'PATCH', body: { pinned: !session.pinned } });
      await loadSessions();
    });
    list.append(item);
  }
}

/* ------------------------------------------------------------------ */
/* recent searches                                                     */
/* ------------------------------------------------------------------ */

function searchItemNode(entry, { compact = false } = {}) {
  const node = el('div', { class: 'search-item' }, [
    el('div', { class: 'q' }, [
      el('span', { text: entry.pinned ? '📌' : '🔎' }),
      el('span', { text: entry.query }),
    ]),
    el('div', { class: 'meta' }, [
      entry.result_count === 0
        ? el('span', { class: 'pill pill-warn', text: 'no results' })
        : el('span', { text: `${entry.provider} · ${entry.result_count} results` }),
      el('span', { text: timeAgo(entry.created_at) }),
      el('span', { class: `pill ${entry.source === 'user' ? '' : 'pill-ok'}`, text: entry.source === 'user' ? 'you' : 'agent' }),
      el('span', { class: 'acts' }, [
        el('button', {
          text: '↻',
          title: 'Run this search again',
          onclick: async (event) => {
            event.stopPropagation();
            await runSearchNow(entry.query);
          },
        }),
        el('button', {
          class: entry.pinned ? 'pinned' : '',
          text: '★',
          title: entry.pinned ? 'Unpin' : 'Pin',
          onclick: async (event) => {
            event.stopPropagation();
            await api(`/api/searches/${entry.id}/pin`, { method: 'POST' });
            await loadSearches();
          },
        }),
        el('button', {
          text: '🗑',
          title: 'Delete',
          onclick: async (event) => {
            event.stopPropagation();
            await api(`/api/searches/${entry.id}`, { method: 'DELETE' });
            await loadSearches();
          },
        }),
      ]),
    ]),
  ]);
  if (!compact) {
    node.addEventListener('click', () => {
      const input = $('#input');
      if (input) {
        input.value = entry.query;
        emit('focus-input');
      }
    });
  }
  return node;
}

export function renderRail() {
  const body = clear($('#rail-body'));
  if (!state.searches.length) {
    body.append(el('div', { class: 'empty small', text: 'No searches yet. Ask Blue to look something up and it will land here.' }));
    return;
  }
  let day = '';
  for (const entry of state.searches.slice(0, 25)) {
    const label = dayLabel(entry.created_at);
    if (label !== day) {
      day = label;
      body.append(el('div', { class: 'rail-day', text: label }));
    }
    body.append(searchItemNode(entry, { compact: true }));
  }
}

export function renderSearchesView() {
  const list = clear($('#search-list'));
  if (!state.searches.length) {
    list.append(el('div', { class: 'empty', text: 'Nothing here yet. Run a search above or ask Blue something that needs the web.' }));
    return;
  }
  let day = '';
  for (const entry of state.searches) {
    const label = dayLabel(entry.created_at);
    if (label !== day) {
      day = label;
      list.append(el('div', { class: 'rail-day', text: label }));
    }
    list.append(searchItemNode(entry));
  }
}

async function runSearchNow(query) {
  const box = $('#search-results');
  clear(box).append(el('div', { class: 'muted small', text: `Searching for "${query}"…` }));
  try {
    const data = await api('/api/searches', { method: 'POST', body: { query, max_results: 6 } });
    clear(box);
    if (data.answer) box.append(el('div', { class: 'small', style: 'margin-bottom:10px', text: data.answer }));
    const grid = el('div', { class: 'result-list', style: 'margin-bottom:16px' });
    for (const [index, r] of data.results.entries()) {
      grid.append(
        el('a', { class: 'result', href: r.url, target: '_blank', rel: 'noopener noreferrer' }, [
          el('b', { text: `${index + 1}. ${r.title || r.url}` }),
          el('span', { text: r.snippet || '' }),
          el('code', { text: r.url }),
        ]),
      );
    }
    box.append(grid);
    await loadSearches();
  } catch (error) {
    clear(box).append(el('div', { class: 'small', style: 'color:var(--err)', text: error.message }));
  }
}

/* ------------------------------------------------------------------ */
/* memories                                                            */
/* ------------------------------------------------------------------ */

export function renderMemories() {
  const list = clear($('#mem-list'));
  if (!state.memories.length) {
    list.append(
      el('div', { class: 'empty', text: 'No memories yet. Try telling Blue "remember my timezone is Asia/Kolkata" in a chat.' }),
    );
    return;
  }
  const table = el('table', { class: 'table' });
  table.append(
    el('thead', {}, [
      el('tr', {}, [el('th', { text: 'Key' }), el('th', { text: 'Value' }), el('th', { text: 'Source' }), el('th', { text: 'Updated' }), el('th', { text: '' })]),
    ]),
  );
  const tbody = el('tbody');
  for (const memory of state.memories) {
    tbody.append(
      el('tr', {}, [
        el('td', {}, [el('code', { text: memory.key })]),
        el('td', { text: memory.value }),
        el('td', {}, [el('span', { class: `pill ${memory.source === 'user' ? '' : 'pill-ok'}`, text: memory.source })]),
        el('td', { class: 'muted small', text: timeAgo(memory.updated_at) }),
        el('td', {}, [
          el('button', {
            class: 'btn btn-ghost btn-sm',
            text: '🗑',
            onclick: async () => {
              await api(`/api/memories/${memory.id}`, { method: 'DELETE' });
              await loadMemories();
            },
          }),
        ]),
      ]),
    );
  }
  table.append(tbody);
  list.append(table);
}

/* ------------------------------------------------------------------ */
/* tools                                                               */
/* ------------------------------------------------------------------ */

export function renderToolsView() {
  const list = clear($('#tools-list'));
  for (const tool of state.tools) {
    const toggle = el('div', { class: `toggle ${tool.enabled ? 'on' : ''}` });
    const row = el('div', { class: 'switch' }, [
      el('span', { style: 'font-size:18px', text: toolIcon(tool.name) }),
      el('span', { class: 'lbl' }, [el('b', { text: tool.name }), el('span', { text: tool.description })]),
      toggle,
    ]);
    toggle.addEventListener('click', async () => {
      const enabled = new Set(state.settings.tools_enabled);
      if (enabled.has(tool.name)) enabled.delete(tool.name);
      else enabled.add(tool.name);
      const { settings } = await api('/api/settings', { method: 'PUT', body: { tools_enabled: [...enabled] } });
      state.settings = settings;
      await loadTools();
      emit('settings');
      toast(`${tool.name} ${enabled.has(tool.name) ? 'enabled' : 'disabled'}`, 'ok');
    });
    list.append(row);
  }
}

export function renderToolToggles() {
  const wrap = clear($('#tool-toggles'));
  const enabled = new Set(state.settings?.tools_enabled || []);
  for (const tool of state.tools) {
    wrap.append(
      el('button', {
        class: `chip-toggle ${enabled.has(tool.name) ? 'on' : ''}`,
        text: `${toolIcon(tool.name)} ${tool.name}`,
        title: `${tool.description}\n(click to ${enabled.has(tool.name) ? 'disable' : 'enable'})`,
        onclick: async () => {
          const next = new Set(state.settings.tools_enabled);
          if (next.has(tool.name)) next.delete(tool.name);
          else next.add(tool.name);
          const { settings } = await api('/api/settings', { method: 'PUT', body: { tools_enabled: [...next] } });
          state.settings = settings;
          await loadTools();
          renderToolsView();
          renderToolToggles();
        },
      }),
    );
  }
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

export function renderSettings() {
  const settings = state.settings || {};
  const providerSelect = $('#set-provider');
  const topbarSelect = $('#provider-select');
  for (const select of [providerSelect, topbarSelect]) {
    if (!select) continue;
    clear(select);
    for (const provider of state.providers) {
      select.append(
        el('option', {
          value: provider.id,
          text: `${provider.label}${provider.kind === 'local' ? ' (offline)' : ''}`,
          selected: provider.id === settings.provider ? 'selected' : null,
        }),
      );
    }
  }
  if ($('#set-model')) $('#set-model').value = settings.model || '';
  if ($('#model-input')) $('#model-input').value = settings.model || '';
  if ($('#set-temp')) {
    $('#set-temp').value = settings.temperature ?? 0.7;
    $('#temp-value').textContent = Number(settings.temperature ?? 0.7).toFixed(2);
  }
  if ($('#set-prompt')) $('#set-prompt').value = settings.system_prompt || '';

  const list = clear($('#provider-list'));
  for (const provider of state.providers) {
    list.append(
      el('div', { class: 'list-row' }, [
        el('span', { class: 'dot', style: provider.kind === 'local' ? 'background:var(--accent-2);box-shadow:none' : '' }),
        el('span', { class: 'grow' }, [
          el('b', { text: provider.label }),
          el('span', { class: 'sub', text: `${provider.id} · default model ${provider.model}` }),
        ]),
        el('span', { class: 'pill pill-ok', text: 'ready' }),
      ]),
    );
  }
  const configured = Object.entries(state.limits?.searchProviders || {})
    .filter(([, v]) => v)
    .map(([k]) => k);
  list.append(
    el('div', { class: 'list-row' }, [
      el('span', { text: '🔎' }),
      el('span', { class: 'grow' }, [
        el('b', { text: 'Web search' }),
        el('span', { class: 'sub', text: `active providers: ${configured.join(', ')}` }),
      ]),
    ]),
  );
}

export async function saveSettings(patch) {
  const { settings } = await api('/api/settings', { method: 'PUT', body: patch });
  state.settings = settings;
  renderSettings();
  renderToolToggles();
  toast('Settings saved', 'ok');
  return settings;
}

/* ------------------------------------------------------------------ */
/* account                                                             */
/* ------------------------------------------------------------------ */

export function renderStats() {
  const row = clear($('#stat-row'));
  const stats = state.stats || {};
  const cards = [
    ['Chats', stats.chats ?? '–'],
    ['Messages', stats.messages ?? '–'],
    ['Searches', stats.searches ?? '–'],
    ['Memories', stats.memories ?? '–'],
  ];
  for (const [label, value] of cards) {
    row.append(el('div', { class: 'stat' }, [el('b', { text: String(value) }), el('span', { text: label })]));
  }
  if (stats.last_search) {
    row.append(
      el('div', { class: 'stat' }, [
        el('b', { class: 'small', style: 'font-size:12.5px', text: stats.last_search.query.slice(0, 40) }),
        el('span', { text: `last search · ${timeAgo(stats.last_search.created_at)}` }),
      ]),
    );
  }
}

export function renderProfile() {
  if ($('#acc-name')) $('#acc-name').value = state.user?.name || '';
  if ($('#acc-email')) $('#acc-email').value = state.user?.email || '';
}

export function renderDeviceSessions() {
  const list = clear($('#session-list'));
  $('#session-count').textContent = state.deviceSessions.filter((s) => s.active).length;
  for (const session of state.deviceSessions) {
    const agent = session.user_agent || 'unknown client';
    const browser = /firefox/i.test(agent) ? 'Firefox' : /edg/i.test(agent) ? 'Edge' : /chrome/i.test(agent) ? 'Chrome' : /safari/i.test(agent) ? 'Safari' : /curl|node|python/i.test(agent) ? 'API client' : 'Browser';
    list.append(
      el('div', { class: 'list-row' }, [
        el('span', { style: 'font-size:18px', text: session.current ? '📱' : '💻' }),
        el('span', { class: 'grow' }, [
          el('b', {}, [browser, session.current ? el('span', { class: 'pill pill-ok', style: 'margin-left:8px', text: 'this device' }) : null]),
          el('span', { class: 'sub', text: `${session.ip || 'unknown ip'} · started ${shortDate(session.created_at)} · last seen ${timeAgo(session.last_seen_at)} · expires ${shortDate(session.expires_at)}` }),
        ]),
        session.active
          ? el('button', {
              class: 'btn btn-ghost btn-sm',
              text: session.current ? 'Sign out' : 'Revoke',
              onclick: async () => {
                if (session.current) return emit('signout');
                await api(`/api/auth/sessions/${session.id}`, { method: 'DELETE' });
                await loadDeviceSessions();
                renderDeviceSessions();
                toast('Session revoked', 'ok');
              },
            })
          : el('span', { class: 'pill pill-err', text: 'revoked' }),
      ]),
    );
  }
}

export function renderApiKeys() {
  const list = clear($('#key-list'));
  if (!state.apiKeys.length) {
    list.append(el('div', { class: 'empty small', text: 'No API keys yet.' }));
    return;
  }
  for (const key of state.apiKeys) {
    list.append(
      el('div', { class: 'list-row' }, [
        el('span', { text: '🔑' }),
        el('span', { class: 'grow' }, [
          el('b', { text: key.label }),
          el('span', { class: 'sub', text: `blue_sk_${key.prefix}_…  ·  scopes: ${(key.scopes || []).join(', ') || 'chat'}  ·  ${key.last_used_at ? `last used ${timeAgo(key.last_used_at)}` : 'never used'}` }),
        ]),
        key.active
          ? el('button', {
              class: 'btn btn-danger btn-sm',
              text: 'Revoke',
              onclick: async () => {
                await api(`/api/auth/keys/${key.id}`, { method: 'DELETE' });
                await loadApiKeys();
                renderApiKeys();
                toast('Key revoked', 'ok');
              },
            })
          : el('span', { class: 'pill pill-err', text: 'revoked' }),
      ]),
    );
  }
}

export function renderAuthEvents() {
  const list = clear($('#event-list'));
  if (!state.authEvents.length) {
    list.append(el('div', { class: 'empty small', text: 'No credential events recorded yet.' }));
    return;
  }
  const table = el('table', { class: 'table' });
  table.append(el('thead', {}, [el('tr', {}, [el('th', { text: 'When' }), el('th', { text: 'Event' }), el('th', { text: 'Status' }), el('th', { text: 'IP' }), el('th', { text: 'Detail' })])]));
  const tbody = el('tbody');
  for (const event of state.authEvents) {
    tbody.append(
      el('tr', {}, [
        el('td', { class: 'muted small', text: timeAgo(event.created_at) }),
        el('td', {}, [el('code', { text: event.event })]),
        el('td', {}, [el('span', { class: `pill ${event.status === 'ok' ? 'pill-ok' : 'pill-warn'}`, text: event.status })]),
        el('td', { class: 'muted small', text: event.ip || '–' }),
        el('td', { class: 'muted small', text: (event.detail || '').slice(0, 60) }),
      ]),
    );
  }
  table.append(tbody);
  list.append(table);
}

/* ------------------------------------------------------------------ */
/* account actions                                                     */
/* ------------------------------------------------------------------ */

export async function createApiKey() {
  const label = $('#key-label')?.value.trim() || 'API key';
  const data = await api('/api/auth/keys', { method: 'POST', body: { label } });
  $('#key-label').value = '';
  await modal({
    title: 'Copy your API key now',
    description: 'This is the only time the secret is shown — the server stores just a SHA-256 hash of it.',
    render: `<code class="secret">${data.plaintext}</code><p class="hint" style="margin-top:10px">${data.usage}</p>`,
    actions: [
      { label: 'Copy key', variant: '', onClick: () => copyText(data.plaintext) },
      { label: 'Done', variant: 'btn-primary', value: null },
    ],
  });
  await loadApiKeys();
  renderApiKeys();
}

export async function changePassword() {
  const current = $('#pw-current').value;
  const next = $('#pw-new').value;
  if (!current || !next) return toast('Fill both password fields', 'err');
  try {
    const data = await api('/api/auth/password', { method: 'POST', body: { current_password: current, new_password: next } });
    $('#pw-current').value = '';
    $('#pw-new').value = '';
    toast(data.message || 'Password updated', 'ok');
    await loadDeviceSessions();
    renderDeviceSessions();
  } catch (error) {
    toast(error.message, 'err');
  }
}

export async function saveProfile() {
  try {
    const { user } = await api('/api/auth/me', {
      method: 'PATCH',
      body: { name: $('#acc-name').value, email: $('#acc-email').value },
    });
    state.user = user;
    $('#user-name').textContent = user.name;
    $('#user-email').textContent = user.email;
    $('#user-avatar').textContent = initials(user.name, user.email);
    toast('Profile updated', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
}

export async function deleteAccount() {
  const ok = await confirmAction({
    title: 'Delete your account?',
    description: 'Every chat, message, search, memory and API key will be erased immediately.',
    confirmLabel: 'Delete everything',
  });
  if (!ok) return;
  const password = await modal({
    title: 'Confirm your password',
    description: 'This is the last check before your data is destroyed.',
    render: '<input class="input" id="del-password" type="password" placeholder="Password" />',
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Delete account', variant: 'btn-danger', onClick: (close) => close($('#del-password').value) },
    ],
  });
  if (!password) return;
  try {
    await api('/api/auth/account', { method: 'DELETE', body: { password } });
    toast('Account deleted', 'ok');
    emit('signout');
  } catch (error) {
    toast(error.message, 'err');
  }
}

export function renderAll() {
  renderConversationList();
  renderRail();
  renderSearchesView();
  renderMemories();
  renderToolsView();
  renderSettings();
  renderToolToggles();
  if (currentSession()) $('#topbar-title').textContent = currentSession().title;
}
