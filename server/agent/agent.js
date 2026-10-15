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
  const isFirstMessage = all('SELECT id FROM messages WHERE chat_session_id = ? LIMIT 1', session.id).length === 0;
  if (persistUserMessage) {
    addMessage({ sessionId: session.id, userId: user.id, role: 'user', content: userText });
  }

  let title = session.title;
  if (isFirstMessage && (session.title === 'New chat' || !session.title)) {
    title = titleFromMessage(userText);
    touchChatSession(session.id, { title });
    onEvent({ type: 'title', title });
  }

  // ---- assemble model context --------------------------------------
  const memories = listMemories(user.id);
  const searches = recentSearches(user.id, { limit: 8 });
  const system = buildSystemPrompt({
    customPrompt: settings.system_prompt,
    memories,
    recentSearches: searches,
    user,
    sessionTitle: title,
  });

  const historyRows = all(
    `SELECT * FROM messages WHERE chat_session_id = ? AND user_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 400`,
    session.id,
    user.id,
  );
  // The user's turn is already persisted above, so the stored history *includes*
  // it — never drop it, or the model answers the previous message.
  const messages = rowsToModelMessages(historyRows);

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
        ? runLocalEngine({ messages, tools, context: { userId: user.id, user, sessionId: session.id } })
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
    addMessage({
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
        pushToolResult(messages, session, user, call, payload, onEvent);
        continue;
      }
      onEvent({ type: 'tool_start', id: call.id, name: call.name, args });
      const result = await executeTool(call.name, args, { userId: user.id, chatSessionId: session.id });
      const payload = { ...result, __tool: call.name };
      pushToolResult(messages, session, user, call, payload, onEvent);
    }
  }

  // ---- persist the final assistant answer ---------------------------
  const finalRow = addMessage({
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

function pushToolResult(messages, session, user, call, payload, onEvent) {
  // The stored/forwarded content is the JSON payload: remote models read it
  // fine and the local engine parses it to write its answer.
  const content = JSON.stringify(payload);
  addMessage({
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
      out.push({ role: 'user', content: row.content });
    }
  }
  return out;
}
