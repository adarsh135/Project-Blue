import { visitorHeaders, clearVisitorKey } from './byok.js';
/** HTTP client: cookie sessions + CSRF header + SSE stream reader. */
export function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)blue_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}
export class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}
export async function api(path, { method = 'GET', body, headers = {}, raw = false, signal } = {}) {
  const options = { method, signal, credentials: 'same-origin', headers: { ...headers } };
  if (path === '/api/auth/logout') clearVisitorKey();
  if (path === '/api/chat' && method === 'POST') Object.assign(options.headers, await visitorHeaders(body));
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const token = csrfToken();
    if (token) options.headers['x-blue-csrf'] = token;
  }
  const res = await fetch(path, options);
  if (raw) return res;
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { error: text.slice(0, 300) || res.statusText }; }
  if (!res.ok) throw new ApiError(data.error || `${res.status} ${res.statusText}`, res.status, data);
  return data;
}
export async function streamChat(sessionId, payload, { onEvent, signal } = {}) {
  const headers = { 'content-type': 'application/json', ...await visitorHeaders(payload) };
  const token = csrfToken();
  if (token) headers['x-blue-csrf'] = token;
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify(payload), signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error || `Stream failed (${res.status})`, res.status, data);
  }
  if (!res.body) throw new ApiError('Streaming is not supported in this browser', 0, {});
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      if (frame.startsWith(':')) continue;
      const dataLines = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
      if (!dataLines.length) continue;
      try { onEvent?.(JSON.parse(dataLines.join('\n'))); } catch { /* malformed frame */ }
    }
  }
}
