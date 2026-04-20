// ============================================================
// Internal messages[] ↔ per-provider conversation history.
// Pure functions; no Alpine, no DOM.
// ============================================================
//
// Internal message shape (kept in Alpine's `messages[]`):
//   { id, role: "info" | "user" | "assistant" | "tool",
//     content, thinking,              // display only
//     thinkingBlocks,                 // Array<{thinking, signature}> (Anthropic, history round-trip)
//     isJson, isToolCall,             // flags
//     toolCallId, toolCallName, toolCallArgs,   // on assistant tool_use turns
//     toolResult,                     // on tool-result turns ({success, summary?, error?})
//     info, error, streaming }
//
// Per-provider output conforms to each API's messages/contents spec.

const HISTORY_DEFAULT_LIMIT = 20;

function filterInternalMessages(messages) {
  return messages.filter(m =>
    m.role !== "info" && !m.error && m.streaming !== true
  );
}

// Drop orphans: tool_calls without a matching tool_result, and vice versa.
// OpenAI and Anthropic both 400 if a tool turn is sent without its pair.
function pairSafeMessages(messages) {
  const callIds = new Set();
  const resultIds = new Set();
  for (const m of messages) {
    if (m.isToolCall && m.toolCallId) callIds.add(m.toolCallId);
    if (m.role === "tool" && m.toolCallId) resultIds.add(m.toolCallId);
  }
  const validIds = new Set();
  for (const id of callIds) if (resultIds.has(id)) validIds.add(id);
  return messages.filter(m => {
    if (m.isToolCall && m.toolCallId) return validIds.has(m.toolCallId);
    if (m.role === "tool" && m.toolCallId) return validIds.has(m.toolCallId);
    return true;
  });
}

// Take last `limit` messages; if the slice would start mid-pair
// (leading tool_result), extend backward to the preceding tool_call.
function truncatePreservingPairs(messages, limit = HISTORY_DEFAULT_LIMIT) {
  if (messages.length <= limit) return messages;
  let start = messages.length - limit;
  while (start > 0 && messages[start].role === "tool") start--;
  return messages.slice(start);
}

// ---- Per-provider mappers ----

function historyToOpenAI(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content || "" });
    } else if (m.role === "assistant" && m.isToolCall) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: [{
          id: m.toolCallId,
          type: "function",
          function: {
            name: m.toolCallName,
            arguments: JSON.stringify(m.toolCallArgs || {})
          }
        }]
      });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: m.content || "" });
    } else if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: JSON.stringify(m.toolResult || {})
      });
    }
  }
  return out;
}

function historyToAnthropic(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content || "" });
    } else if (m.role === "assistant" && m.isToolCall) {
      // Thinking blocks must precede the tool_use block for extended-thinking multi-turn.
      const blocks = [];
      for (const b of (m.thinkingBlocks || [])) {
        blocks.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
      }
      if (m.content) blocks.push({ type: "text", text: m.content });
      blocks.push({
        type: "tool_use",
        id: m.toolCallId,
        name: m.toolCallName,
        input: m.toolCallArgs || {}
      });
      out.push({ role: "assistant", content: blocks });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: [{ type: "text", text: m.content || "" }] });
    } else if (m.role === "tool") {
      out.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: m.toolCallId,
          content: JSON.stringify(m.toolResult || {})
        }]
      });
    }
  }
  return out;
}

function historyToGemini(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: m.content || "" }] });
    } else if (m.role === "assistant" && m.isToolCall) {
      out.push({
        role: "model",
        parts: [{ functionCall: { name: m.toolCallName, args: m.toolCallArgs || {} } }]
      });
    } else if (m.role === "assistant") {
      out.push({ role: "model", parts: [{ text: m.content || "" }] });
    } else if (m.role === "tool") {
      // Gemini requires `response` to be an object, never a string.
      const response = (m.toolResult && typeof m.toolResult === "object")
        ? m.toolResult
        : { result: m.toolResult };
      out.push({
        role: "user",
        parts: [{ functionResponse: { name: m.toolCallName, response } }]
      });
    }
  }
  return out;
}

function buildHistoryForProvider(messages, provider, limit = HISTORY_DEFAULT_LIMIT) {
  const filtered = filterInternalMessages(messages);
  const paired = pairSafeMessages(filtered);
  const truncated = truncatePreservingPairs(paired, limit);
  if (provider === "anthropic") return historyToAnthropic(truncated);
  if (provider === "gemini") return historyToGemini(truncated);
  return historyToOpenAI(truncated);
}
