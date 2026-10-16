// Deliberately no localStorage, sessionStorage, cookies or settings persistence.
let key = '';
let initialized;
export async function visitorHeaders(payload = {}) {
  await initializeVisitorKeyUI();
  if (payload.provider === 'local') return {};
  return key ? { 'x-blue-provider-key': key } : {};
}
export function clearVisitorKey() {
  key = '';
  const field = document.getElementById('visitor-provider-key');
  if (field) field.value = '';
}
export function initializeVisitorKeyUI() {
  if (initialized) return initialized;
  initialized = (async () => {
    const response = await fetch('/api/status', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return;
    const status = await response.json();
    if (!status.public_byok) return;
    if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    const panel = document.createElement('aside');
    panel.className = 'visitor-key-panel';
    panel.setAttribute('aria-label', 'Visitor AI credentials');
    const label = document.createElement('label');
    label.textContent = 'Your AI provider key (this tab only): ';
    const field = document.createElement('input');
    field.id = 'visitor-provider-key';
    field.type = 'password';
    field.autocomplete = 'off';
    field.spellcheck = false;
    field.maxLength = 512;
    field.addEventListener('input', () => { key = field.value.trim(); });
    label.append(field);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Clear key';
    clear.addEventListener('click', clearVisitorKey);
    const help = document.createElement('p');
    help.textContent = 'Choose the matching provider and model in Settings. Your key is sent over HTTPS through this server to that provider, never saved by Blue. The provider may charge you. Reload or clear to forget it. Research/page fetching are disabled on this public deployment. Never paste a key into chat.';
    panel.append(label, clear, help);
    document.body.prepend(panel);
  })().catch(() => { initialized = undefined; });
  return initialized;
}
window.addEventListener('pagehide', clearVisitorKey);
initializeVisitorKeyUI();
