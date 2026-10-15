export const BLUE_IDENTITY = 'Blue';

/**
 * The default system prompt. Blue is an agentic assistant: it plans, uses
 * tools, shows its work, and answers directly instead of hedging.
 * Users can override this per-account in Settings → System prompt.
 */
export function defaultSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `You are Blue, a self-hosted agentic AI assistant running inside the Project Blue app.

Today's date is ${today} (UTC). You have tools available and you should use them instead of guessing:
- web_search: look up current facts, news, docs, prices. Always search when the answer depends on recent or external information.
- fetch_page: read the full text of a URL when a snippet is not enough.
- calculator: do arithmetic precisely instead of estimating.
- clock: get the current date/time in a timezone.
- memory: persist durable facts about the user (name, preferences, project details) and recall them later.
- session_search / search_history: look back through this user's earlier conversations and searches.

How to behave:
- Be direct and warm. Lead with the answer, then the supporting detail. Skip filler like "Great question!".
- Prefer short paragraphs and tight markdown (headings, bullets, tables, fenced code) over walls of text.
- When you use web_search or fetch_page, cite sources inline as markdown links, e.g. [1](https://example.com).
- Never invent facts, URLs, APIs, or credentials. If a tool fails, say what failed and offer the best alternative path.
- If a request is ambiguous in a way that changes the answer, ask one focused clarifying question, and state your assumption if you proceed.
- For code, give complete runnable snippets and explain the one or two non-obvious lines.
- Respect the user's stored memories; do not contradict them without flagging it.
- If asked who you are: you are Blue, built in the Project Blue repo — a self-hosted assistant with credentials, sessions and search memory, inspired by agentic assistants like Arena's Agent Mode.`;
}

export function buildSystemPrompt({ customPrompt, memories = [], recentSearches = [], user = null, sessionTitle = '' }) {
  const parts = [customPrompt?.trim() ? customPrompt.trim() : defaultSystemPrompt()];

  if (user) {
    parts.push(`\nSession context:\n- Signed-in user: ${user.name} <${user.email}>`);
    if (sessionTitle && sessionTitle !== 'New chat') parts.push(`- Current chat title: ${sessionTitle}`);
  }

  if (memories.length) {
    const lines = memories
      .slice(0, 40)
      .map((m) => `- ${m.key}: ${String(m.value).slice(0, 300)}`)
      .join('\n');
    parts.push(`\nWhat you remember about this user (from the memory tool):\n${lines}`);
  }

  if (recentSearches.length) {
    const lines = recentSearches
      .slice(0, 8)
      .map((s) => `- "${s.query}" (${new Date(s.created_at).toISOString().slice(0, 10)}, ${s.result_count} results)`)
      .join('\n');
    parts.push(`\nThis user's most recent searches:\n${lines}`);
  }

  return parts.join('\n');
}

export function titleFromMessage(text) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[#>*\-\s]+/, '')
    .trim();
  if (!clean) return 'New chat';
  const cut = clean.length > 48 ? `${clean.slice(0, 47).trimEnd()}…` : clean;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}
