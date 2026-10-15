/** Small DOM/UX helpers shared by every view. */

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

export function on(selector, event, handler, scope = document) {
  const node = typeof selector === 'string' ? $(selector, scope) : selector;
  node?.addEventListener(event, handler);
  return node;
}

export const clear = (node) => {
  if (node) node.innerHTML = '';
  return node;
};

export const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
};

export function toast(message, kind = '') {
  const root = $('#toasts');
  const node = el('div', { class: `toast ${kind}`, text: message });
  root.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    setTimeout(() => node.remove(), 260);
  }, kind === 'err' ? 5200 : 3200);
}

/** Modal with a promise result. `render(close)` may return a node or HTML string. */
export function modal({ title, description = '', render, actions, width }) {
  return new Promise((resolve) => {
    const root = $('#modal-root');
    const body = el('div');
    if (typeof render === 'string') body.innerHTML = render;
    else if (render) body.append(render);

    const close = (value) => {
      backdrop.remove();
      resolve(value);
    };

    const footer = el('div', { class: 'modal-actions' });
    for (const action of actions || [{ label: 'Close', value: null }]) {
      footer.append(
        el('button', {
          class: `btn ${action.variant || ''}`,
          text: action.label,
          onclick: async () => {
            const result = action.onClick ? await action.onClick(close) : action.value;
            if (result !== 'keep-open') close(result);
          },
        }),
      );
    }

    const card = el('div', { class: 'modal', style: width ? `width:min(${width}, 100%)` : null }, [
      el('h3', { text: title }),
      description ? el('p', { class: 'desc', text: description }) : null,
      body,
      footer,
    ]);
    const backdrop = el('div', { class: 'modal-backdrop' }, [card]);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close(null);
    });
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'Escape') close(null);
      },
      { once: true },
    );
    root.append(backdrop);
  });
}

export async function confirmAction({ title, description, confirmLabel = 'Confirm', danger = true }) {
  const result = await modal({
    title,
    description,
    actions: [
      { label: 'Cancel', value: false },
      { label: confirmLabel, variant: danger ? 'btn-danger' : 'btn-primary', value: true },
    ],
  });
  return result === true;
}

export const initials = (name = '', email = '') => {
  const source = (name || email || '?').trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
};

export function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export const shortDate = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const dayLabel = (iso) => {
  const date = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  const today = new Date();
  const todayKey = today.toISOString().slice(0, 10);
  const yesterday = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);
  const key = String(iso).slice(0, 10);
  if (key === todayKey) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
};

export const providerLabel = (id) =>
  ({ local: 'Blue Local Engine', openai: 'OpenAI-compatible', anthropic: 'Anthropic', gemini: 'Google Gemini', ollama: 'Ollama' }[id] || id);

export const toolIcon = (name) =>
  ({ web_search: '🔎', fetch_page: '📄', calculator: '🧮', clock: '🕒', memory: '🧠', session_search: '💬', search_history: '🗂️' }[name] || '🧩');

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard', 'ok');
    return true;
  } catch {
    toast('Clipboard blocked by the browser', 'err');
    return false;
  }
}

export const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export function autoGrow(textarea, max = 210) {
  const resize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, max)}px`;
  };
  textarea.addEventListener('input', resize);
  return resize;
}
