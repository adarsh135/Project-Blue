import { api } from './api.js';
import { state, subscribe, currentSession } from './store.js';
import * as chat from './chat.js';
import * as panels from './panels.js';
import { $, autoGrow, confirmAction, el, escapeHtml, initials, on, providerLabel, toast } from './ui.js';

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  applyTheme(localStorage.getItem('blue-theme') || 'dark');
  wireAuthForms();
  wireShell();

  try {
    const meta = await api('/api/auth/providers');
    const pill = $('#engine-pill');
    const local = meta.providers.find((p) => p.kind === 'local');
    const remote = meta.providers.filter((p) => p.kind === 'remote');
    if (pill) {
      pill.innerHTML = remote.length
        ? `<span class="dot"></span> ${remote.length} provider${remote.length > 1 ? 's' : ''} ready · ${escapeHtml(remote[0].label)}`
        : '<span class="dot"></span> Blue Local Engine (no API key needed)';
    }
    $('#ttl-days').textContent = Math.round((meta.limits?.sessionTtlHours || 168) / 24);
    state.version = meta.version || state.version;
    $('#version-pill').textContent = state.version;
    state.providers = meta.providers;
    state.limits = meta.limits;
    void local;
  } catch {
    /* server not reachable yet — the login POST will surface it */
  }

  try {
    const me = await api('/api/auth/me');
    if (me.authenticated) {
      state.user = me.user;
      state.settings = me.settings;
      await showApp();
    } else {
      showAuth();
    }
  } catch {
    showAuth();
  }
}

function showAuth() {
  $('#auth-screen').style.display = 'grid';
  $('#app').classList.remove('ready');
}

async function showApp() {
  $('#auth-screen').style.display = 'none';

  $('#user-name').textContent = state.user.name;
  $('#user-email').textContent = state.user.email;
  $('#user-avatar').textContent = initials(state.user.name, state.user.email);

  // Populate everything before revealing the shell, so the UI never flashes
  // empty panels (and tests get a deterministic moment to hook onto).
  await Promise.all([
    state.providers.length ? Promise.resolve() : panels.loadProviders(),
    panels.loadSessions(),
    panels.loadSearches(),
    panels.loadMemories(),
    panels.loadTools(),
  ]);

  panels.renderAll();
  wireConversationInteractions();
  $('#app').classList.toggle('with-rail', state.railOpen);
  $('#app').classList.add('ready');
  wireConversationInteractions();

  const mostRecent = state.sessions[0];
  if (mostRecent) await openSession(mostRecent.id);
  else newChat();
}

/* ------------------------------------------------------------------ */
/* auth UI                                                             */
/* ------------------------------------------------------------------ */

function wireAuthForms() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      const register = tab.dataset.tab === 'register';
      $('#login-form').style.display = register ? 'none' : 'block';
      $('#register-form').style.display = register ? 'block' : 'none';
      showAuthError('');
    });
  }

  on('#login-form', 'submit', async (event) => {
    event.preventDefault();
    const button = $('#login-submit');
    button.disabled = true;
    button.textContent = 'Signing in…';
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: { email: $('#login-email').value, password: $('#login-password').value },
      });
      state.user = data.user;
      state.settings = data.settings;
      await showApp();
      toast(`Welcome back, ${data.user.name.split(' ')[0]}`, 'ok');
    } catch (error) {
      showAuthError(error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Sign in';
    }
  });

  on('#register-form', 'submit', async (event) => {
    event.preventDefault();
    const button = $('#register-submit');
    button.disabled = true;
    button.textContent = 'Creating…';
    try {
      const data = await api('/api/auth/register', {
        method: 'POST',
        body: {
          name: $('#reg-name').value,
          email: $('#reg-email').value,
          password: $('#reg-password').value,
        },
      });
      state.user = data.user;
      state.settings = data.settings;
      await showApp();
      toast('Account created — welcome to Blue', 'ok');
    } catch (error) {
      showAuthError(error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Create account';
    }
  });
}

function showAuthError(message) {
  const box = $('#auth-error');
  box.textContent = message || '';
  box.classList.toggle('show', Boolean(message));
}

/* ------------------------------------------------------------------ */
/* shell wiring                                                        */
/* ------------------------------------------------------------------ */

function wireShell() {
  // navigation
  for (const item of document.querySelectorAll('.nav-item')) {
    item.addEventListener('click', () => setView(item.dataset.view));
  }

  on('#user-chip', 'click', () => $('#user-menu').classList.toggle('open'));
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#user-menu') && !event.target.closest('#user-chip')) {
      $('#user-menu')?.classList.remove('open');
    }
  });
  on('#menu-signout', 'click', signOut);

  on('#new-chat', 'click', newChat);
  on('#conv-filter', 'input', (event) => {
    state.conversationFilter = event.target.value;
    panels.renderConversationList();
  });

  on('#theme-toggle', 'click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    localStorage.setItem('blue-theme', next);
  });

  // composer
  const input = $('#input');
  autoGrow(input);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      chat.sendTurn(input.value);
    }
  });
  on('#send-btn', 'click', () => chat.sendTurn(input.value));
  on('#stop-btn', 'click', () => {
    chat.stopStreaming();
    toast('Stopped generating');
  });
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#input').focus();
    }
  });

  // rail
  on('#rail-toggle', 'click', () => {
    state.railOpen = !state.railOpen;
    $('#app').classList.toggle('with-rail', state.railOpen);
  });
  on('#rail-view-all', 'click', () => setView('searches'));
  on('#sidebar-toggle', 'click', () => $('#sidebar').classList.toggle('open'));

  // topbar provider / model
  on('#provider-select', 'change', async (event) => {
    const provider = state.providers.find((p) => p.id === event.target.value);
    await panels.saveSettings({ provider: event.target.value, model: provider?.model });
    updateTopbarSub();
  });
  on('#model-input', 'change', async (event) => {
    await panels.saveSettings({ model: event.target.value });
    updateTopbarSub();
  });

  // searches view
  on('#search-run', 'click', async () => {
    const query = $('#search-box').value.trim();
    if (!query) return;
    await runSearchFromPanel(query);
  });
  on('#search-box', 'keydown', async (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const query = event.target.value.trim();
      if (query) await runSearchFromPanel(query);
    }
  });
  on('#search-filter', 'input', debounce(async (event) => {
    state.searchFilter = event.target.value.trim();
    await panels.loadSearches();
  }, 250));
  on('#search-pinned-only', 'click', async () => {
    state.pinnedOnly = !state.pinnedOnly;
    $('#search-pinned-only').classList.toggle('btn-primary', state.pinnedOnly);
    await panels.loadSearches();
  });
  on('#search-clear', 'click', async () => {
    const ok = await confirmAction({
      title: 'Clear search history?',
      description: 'Unpinned searches will be deleted. Pinned ones are kept.',
      confirmLabel: 'Clear',
    });
    if (!ok) return;
    await api('/api/searches', { method: 'DELETE' });
    await panels.loadSearches();
    toast('Search history cleared', 'ok');
  });

  // memories view
  on('#mem-add', 'click', async () => {
    const key = $('#mem-key').value.trim();
    const value = $('#mem-value').value.trim();
    if (!key || !value) return toast('Both key and value are required', 'err');
    await api('/api/memories', { method: 'POST', body: { key, value } });
    $('#mem-key').value = '';
    $('#mem-value').value = '';
    await panels.loadMemories();
    toast('Memory saved', 'ok');
  });

  // settings view
  on('#set-temp', 'input', (event) => ($('#temp-value').textContent = Number(event.target.value).toFixed(2)));
  on('#set-save', 'click', () =>
    panels.saveSettings({
      provider: $('#set-provider').value,
      model: $('#set-model').value,
      temperature: Number($('#set-temp').value),
      system_prompt: $('#set-prompt').value,
    }).then(updateTopbarSub),
  );
  on('#set-default', 'click', () => {
    $('#set-prompt').value = '';
    panels.saveSettings({ system_prompt: null });
  });
  on('#set-provider', 'change', (event) => {
    const provider = state.providers.find((p) => p.id === event.target.value);
    $('#set-model').value = provider?.model || '';
  });

  // account view
  on('#acc-save', 'click', panels.saveProfile);
  on('#pw-save', 'click', panels.changePassword);
  on('#key-create', 'click', panels.createApiKey);
  on('#session-revoke-all', 'click', async () => {
    await api('/api/auth/sessions', { method: 'DELETE' });
    await panels.loadDeviceSessions();
    panels.renderDeviceSessions();
    toast('Other sessions revoked', 'ok');
  });
  on('#account-delete', 'click', panels.deleteAccount);

  // event bus
  subscribe('sessions', () => panels.renderConversationList());
  subscribe('searches', () => {
    panels.renderRail();
    panels.renderSearchesView();
  });
  subscribe('memories', () => panels.renderMemories());
  subscribe('tools', () => {
    panels.renderToolsView();
    panels.renderToolToggles();
  });
  subscribe('settings', () => panels.renderSettings());
  subscribe('open-session', (id) => (id ? openSession(id) : newChat()));
  subscribe('signout', signOut);
  subscribe('focus-input', () => $('#input').focus());
  subscribe('streaming', () => {
    const streaming = state.streaming;
    $('#send-btn').style.display = streaming ? 'none' : 'inline-flex';
    $('#stop-btn').style.display = streaming ? 'inline-flex' : 'none';
  });
  subscribe('searches-dirty', debounce(() => panels.loadSearches().catch(() => {}), 400));
  subscribe('sessions-dirty', debounce(() => panels.loadSessions().catch(() => {}), 300));
}

function wireConversationInteractions() {
  // suggestion buttons inside the welcome card are wired when rendered
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function setView(view) {
  state.view = view;
  for (const item of document.querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.dataset.view === view);
  }
  const chatView = $('#view-chat');
  const isChat = view === 'chat';
  chatView.style.display = isChat ? 'flex' : 'none';
  for (const id of ['searches', 'memories', 'tools', 'settings', 'account']) {
    $(`#view-${id}`).style.display = view === id ? 'block' : 'none';
  }
  $('#rail').style.display = isChat && state.railOpen ? 'flex' : 'none';
  $('#sidebar').classList.remove('open');

  if (view === 'account') refreshAccountView();
  if (view === 'searches') panels.loadSearches().catch(() => {});
}

async function refreshAccountView() {
  try {
    const [me] = await Promise.all([api('/api/auth/me'), panels.loadStats(), panels.loadDeviceSessions(), panels.loadApiKeys(), panels.loadAuthEvents()]);
    if (me.user) state.user = me.user;
    panels.renderStats();
    panels.renderProfile();
    panels.renderDeviceSessions();
    panels.renderApiKeys();
    panels.renderAuthEvents();
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function runSearchFromPanel(query) {
  const box = $('#search-results');
  clear(box).append(el('div', { class: 'muted small', text: `Searching for "${query}"…` }));
  try {
    const data = await api('/api/searches', { method: 'POST', body: { query, max_results: 6 } });
    clear(box);
    if (data.answer) box.append(el('div', { class: 'small', style: 'margin-bottom:10px', text: data.answer }));
    const list = el('div', { class: 'result-list', style: 'margin-bottom:18px' });
    for (const [index, result] of data.results.entries()) {
      list.append(
        el('a', { class: 'result', href: result.url, target: '_blank', rel: 'noopener noreferrer' }, [
          el('b', { text: `${index + 1}. ${result.title || result.url}` }),
          el('span', { text: result.snippet || '' }),
          el('code', { text: result.url }),
        ]),
      );
    }
    box.append(list);
    await panels.loadSearches();
  } catch (error) {
    clear(box).append(el('div', { class: 'small', style: 'color:var(--err)', text: error.message }));
  }
}

/* ------------------------------------------------------------------ */
/* conversation handling                                               */
/* ------------------------------------------------------------------ */

async function openSession(sessionId) {
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) return;
  state.currentSessionId = sessionId;
  $('#topbar-title').textContent = session.title;
  updateTopbarSub();
  panels.renderConversationList();
  setView('chat');
  await chat.reloadConversation(sessionId);
  $('#input')?.focus();
}

function newChat() {
  state.currentSessionId = null;
  state.messages = [];
  $('#topbar-title').textContent = 'New chat';
  updateTopbarSub();
  chat.renderHistory([]);
  panels.renderConversationList();
  setView('chat');
  $('#input')?.focus();
}

function updateTopbarSub() {
  const provider = state.settings?.provider || 'local';
  const model = state.settings?.model || 'blue-local-1';
  $('#topbar-sub').textContent = `${providerLabel(provider)} · ${model}`;
}

async function signOut() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  state.user = null;
  state.currentSessionId = null;
  state.messages = [];
  state.sessions = [];
  showAuth();
  toast('Signed out');
}

/* ------------------------------------------------------------------ */

boot();
