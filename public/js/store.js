/** Single source of truth for the client, plus a tiny event bus. */

export const state = {
  user: null,
  settings: null,
  providers: [],
  limits: null,
  version: '1.0.0',
  view: 'chat',
  railOpen: true,
  sessions: [],
  currentSessionId: null,
  messages: [],
  searches: [],
  searchFilter: '',
  pinnedOnly: false,
  memories: [],
  tools: [],
  authEvents: [],
  apiKeys: [],
  deviceSessions: [],
  stats: null,
  streaming: false,
  conversationFilter: '',
};

const listeners = new Map();

export function subscribe(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

export function emit(event, payload) {
  for (const handler of listeners.get(event) || []) {
    try {
      handler(payload);
    } catch (error) {
      console.error(`[blue] listener for "${event}" failed`, error);
    }
  }
}

export const currentSession = () =>
  state.sessions.find((s) => s.id === state.currentSessionId) || null;
