import { config } from '../config.js';
import { addMessage, all, listMemories, recentSearches, touchChatSession } from '../db.js';
import { log, safeJsonParse, truncate } from '../lib/util.js';
import { streamModel } from './providers.js';
import { runLocalEngine } from './local-engine.js';
import { buildSystemPrompt, titleFromMessage } from './prompt.js';
import { executeTool, toolResultToText, toolsForEnabled } from './tools.js';

/**
 * The agent loop: build context → stream from the model → run any tool calls →
 * feed results back → repeat (bounded) → persist everything.
 *
 * `onEvent` receives stream events for the SSE response.
 */
export async function runAgent({
  user,
  session,
  settings,
  userText,
  attachments = [],
  persistUserMessage = true,
  onEvent = () => {},
  signal,
}) {
  const startedAt = Date.now();
  const providerId = settings.provider || 'local';
  const model = settings.model || 'blue-local-1';
  const tools = toolsForEnabled(settings.tools_enabled);
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // ---- persist the user's turn -------------------------------------
  const isFirstMessage = (await all('SELECT id FROM messages WHERE chat_session_id = ? LIMIT 1', session.id)).length === 0;
  if (persistUserMessage) {
    await addMessage({ sessionId: session.id, userId: user.id, role: 'user', content: userText, attachments });
  }

  let title = session.title;
  if (isFirstMessage && (session.title === 'New chat' || !session.title)) {
    title = titleFromMessage(userText);
    await touchChatSession(session.id, { title });
    onEvent({ type: 'title', title });
  }

  // ---- assemble model context --------------------------------------
  const memories = await listMemories(user.id);
  const searches = await recentSearches(user.id, { limit: 8 });
  const system = buildSystemPrompt({
    customPrompt: settings.system_prompt,
    mode: settings.mode || 'auto',
    memories,
    recentSearches: searches,
    user,
    sessionTitle: title,
  });

  const historyRows = await all(
    `SELECT * FROM messages WHERE chat_session_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    session.id,
    user.id,
    config.maxHistoryMessages,
  );
  historyRows.reverse();
  // The user's turn is already persisted above, so the stored history *includes*
  // it — never drop it, or the model answers the previous message.
  const messages = limitConversationContext(rowsToModelMessages(historyRows), config.maxContextChars);

  onEvent({ type: 'start', sessionId: session.id, provider: providerId, model, title });

  // ---- loop ---------------------------------------------------------
  let rounds = 0;
  let usedLocalFallback = false;
  let finalText = '';  // text of the last round only — earlier rounds are progress notes
  let totalIn = 0;
  let totalOut = 0;
  let lastMessageId = null;
  let providerNoted = false;

  while (rounds <= config.maxToolRounds) {
    rounds += 1;
    let text = '';
    const toolCalls = [];
    let finishReason = 'stop';
    let streamErrored = false;
    let roundIn = 0;
    let roundOut = 0;

    const runStream = (activeProvider) =>
      activeProvider === 'local'
        ? runLocalEngine({ messages, tools, context: { userId: user.id, user, sessionId: session.id, mode: settings.mode || 'auto' } })
        : streamModel({
            providerId: activeProvider,
            model,
            system,
            messages,
            tools,
            temperature: settings.temperature,
            signal,
          });

    const activeProvider = usedLocalFallback || providerId === 'local' ? 'local' : providerId;

    try {
      for await (const event of runStream(activeProvider)) {
        if (signal?.aborted) break;
        switch (event.type) {
          case 'text':
            text += event.text;
            onEvent({ type: 'text', delta: event.text });
            break;
          case 'tool_call':
            toolCalls.push(event);
            break;
          case 'usage':
            roundIn += event.input || 0;
            roundOut += event.output || 0;
            break;
          case 'end':
            finishReason = event.finishReason || 'stop';
            break;
          default:
            break;
        }
      }
    } catch (error) {
      streamErrored = true;
      const message = error?.message || String(error);
      log('agent', `provider ${providerId} failed:`, message);
      onEvent({ type: 'error', message: `${providerId} failed: ${message}` });
      if (providerId !== 'local' && !usedLocalFallback) {
        usedLocalFallback = true;
        providerNoted = true;
        onEvent({
          type: 'text',
          delta: `> ⚠️ **${providerId} is unreachable** (${truncate(message, 160)}). Falling back to the offline Blue Local Engine for this answer.\n\n`,
        });
      } else {
        throw error;
      }
    }

    if (signal?.aborted) break;

    // Only the closing round's prose becomes the answer; tool-round text is
    // already stored on the assistant turn that requested the tools.
    finalText = text;
    // Providers that don't report usage (and the offline engine) get a rough
    // characters/4 estimate, counted per round.
    if (!roundIn && !roundOut) {
      roundIn = Math.ceil((system.length + userText.length) / 4);
      roundOut = Math.ceil(text.length / 4);
    }
    totalIn += roundIn;
    totalOut += roundOut;

    if (!toolCalls.length) break;
    if (rounds > config.maxToolRounds) {
      onEvent({ type: 'text', delta: '\n\n_(stopping: too many tool rounds in one turn)_' });
      break;
    }

    // Persist the assistant's tool-calling turn.
    await addMessage({
      sessionId: session.id,
      userId: user.id,
      role: 'assistant',
      content: text,
      toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, args: c.args })),
      provider: usedLocalFallback || providerId === 'local' ? 'local' : providerId,
      model: usedLocalFallback || providerId === 'local' ? 'blue-local-1' : model,
    });
    messages.push({
      role: 'assistant',
      content: text,
      tool_calls: toolCalls.map((c) => ({ id: c.id, name: c.name, args: parseArgs(c.args) })),
    });

    for (const call of toolCalls) {
      const args = parseArgs(call.args);
      if (!toolMap.has(call.name)) {
        const payload = { ok: false, error: `Tool "${call.name}" is not enabled`, __tool: call.name };
        await pushToolResult(messages, session, user, call, payload, onEvent);
        continue;
      }
      onEvent({ type: 'tool_start', id: call.id, name: call.name, args });
      const result = await executeTool(call.name, args, { userId: user.id, chatSessionId: session.id, attachments });
      const payload = { ...result, __tool: call.name };
      await pushToolResult(messages, session, user, call, payload, onEvent);
    }
  }

  // ---- persist the final assistant answer ---------------------------
  const finalRow = await addMessage({
    sessionId: session.id,
    userId: user.id,
    role: 'assistant',
    content: finalText,
    provider: usedLocalFallback || providerId === 'local' ? 'local' : providerId,
    model: usedLocalFallback || providerId === 'local' ? 'blue-local-1' : model,
    tokensIn: totalIn,
    tokensOut: totalOut,
    latencyMs: Date.now() - startedAt,
  });
  lastMessageId = finalRow.id;

  const done = {
    type: 'done',
    sessionId: session.id,
    messageId: lastMessageId,
    title,
    provider: usedLocalFallback || providerId === 'local' ? 'local' : providerId,
    model: usedLocalFallback || providerId === 'local' ? 'blue-local-1' : model,
    latencyMs: Date.now() - startedAt,
    tokensIn: totalIn,
    tokensOut: totalOut,
    fallbackNotice: providerNoted || undefined,
  };
  onEvent(done);
  return done;
}

async function pushToolResult(messages, session, user, call, payload, onEvent) {
  // The stored/forwarded content is the JSON payload: remote models read it
  // fine and the local engine parses it to write its answer.
  const content = JSON.stringify(payload);
  await addMessage({
    sessionId: session.id,
    userId: user.id,
    role: 'tool',
    name: call.name,
    toolCallId: call.id,
    content,
    provider: 'tool',
    model: call.name,
  });
  messages.push({ role: 'tool', name: call.name, tool_call_id: call.id, content });
  onEvent({
    type: 'tool_result',
    id: call.id,
    name: call.name,
    ok: !!payload.ok,
    summary: payload.summary || payload.error || '',
    detail: toolResultToText(call.name, payload).slice(0, 4000),
    payload,
  });
}

function parseArgs(args) {
  if (args && typeof args === 'object') return args;
  try {
    const parsed = JSON.parse(args || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function limitConversationContext(messages, maxChars) {
  if (!messages.length) return messages;
  const groups = [];
  let group = [];
  for (const message of messages) {
    if (message.role === 'user' && group.length) {
      groups.push(group);
      group = [];
    }
    group.push(message);
  }
  if (group.length) groups.push(group);

  const cost = (message) => String(message.content || '').length +
    (message.attachments || []).reduce((sum, attachment) =>
      sum + (attachment.kind === 'text' ? String(attachment.text || '').length : 0), 0);
  const chosen = [];
  let total = 0;
  for (const candidate of groups.reverse()) {
    const groupCost = candidate.reduce((sum, message) => sum + cost(message), 0);
    if (chosen.length && total + groupCost > maxChars) break;
    chosen.unshift(candidate);
    total += groupCost;
    if (total >= maxChars) break;
  }

  const selected = chosen.flat();
  if (!selected.length) return selected;

  // Do not resend an unbounded trail of image/PDF/audio/video base64. Retain
  // only the newest three media files and replace older ones with safe labels.
  let mediaKept = 0;
  let mediaBytes = 0;
  for (const message of [...selected].reverse()) {
    if (message.role !== 'user' || !Array.isArray(message.attachments)) continue;
    message.attachments = message.attachments.map((attachment) => {
      if (attachment.kind === 'text') return attachment;
      const size = Number(attachment.size) || Math.floor(String(attachment.data || '').length * 3 / 4);
      if (mediaKept < 3 && mediaBytes + size <= 2_600_000) {
        mediaKept += 1;
        mediaBytes += size;
        return attachment;
      }
      return { name: attachment.name, mimeType: attachment.mimeType, kind: 'text', text: `[Earlier media attachment ${attachment.name} omitted from model context.]` };
    });
  }

  // Reserve the configured character budget for the newest user prompt first,
  // then tool evidence and other recent turns. Binary payloads use the separate
  // media budget above; text attachments are clipped only in model context (the
  // original attachment is still stored and supplied to deterministic tools).
  const latestUserIndex = selected.map((message) => message.role).lastIndexOf('user');
  const priority = [];
  if (latestUserIndex >= 0) priority.push(latestUserIndex);
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    if (index !== latestUserIndex && selected[index].role === 'tool') priority.push(index);
  }
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    if (index !== latestUserIndex && selected[index].role !== 'tool') priority.push(index);
  }

  const clip = (value, budget, marker) => {
    const text = String(value || '');
    if (text.length <= budget) return text;
    if (budget <= marker.length) return marker.slice(0, Math.max(0, budget));
    return `${text.slice(0, budget - marker.length)}${marker}`;
  };

  let remaining = maxChars;
  for (const index of priority) {
    const message = selected[index];
    const original = String(message.content || '');
    message.content = clip(original, remaining, '\n[Conversation context truncated to fit its configured limit.]');
    remaining = Math.max(0, remaining - message.content.length);
  }

  for (const message of [...selected].reverse()) {
    if (message.role !== 'user' || !Array.isArray(message.attachments)) continue;
    for (const attachment of [...message.attachments].reverse()) {
      if (attachment.kind !== 'text') continue;
      const original = String(attachment.text || '');
      const marker = '\n[Attachment text truncated for model context; the full file remains stored.]';
      attachment.text = clip(original, remaining, marker);
      remaining = Math.max(0, remaining - attachment.text.length);
    }
  }
  return selected;
}

export function rowsToModelMessages(rows) {
  const out = [];
  for (const row of rows) {
    if (row.role === 'tool') {
      out.push({ role: 'tool', name: row.name || 'tool', tool_call_id: row.tool_call_id || row.id, content: row.content });
    } else if (row.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: row.content || '',
        tool_calls: safeJsonParse(row.tool_calls, undefined),
      });
    } else if (row.role === 'user') {
      out.push({
        role: 'user',
        content: row.content,
        attachments: safeJsonParse(row.attachments, []),
      });
    }
  }
  return out;
}
