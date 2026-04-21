// ============================================================
// Internal messages[] ↔ per-provider conversation history.
// Pure functions; no Alpine, no DOM.
// ============================================================
//
// Internal message shape (kept in Alpine's `messages[]`):
//   { id, role: "info" | "user" | "assistant" | "tool",
//     content, thinking,                 // display only
//     thinkingBlocks,                    // Array<{thinking, signature}> (Anthropic, history round-trip)
//     isJson, isToolCall,                // flags
//     toolCalls: [{id, name, args, result}],   // on assistant tool_use turns (one assistant
//                                              // message can carry multiple parallel tool_calls)
//     toolCallId, toolCallName, toolResult,    // on tool-result messages (role: "tool")
//     info, error, streaming }
//
// Per-provider output conforms to each API's messages/contents spec.

const HISTORY_DEFAULT_LIMIT = 20;

function filterInternalMessages(messages) {
  return messages.filter(m =>
    m.role !== "info" && !m.error && m.streaming !== true
  );
}

// Drop orphans: tool_calls without matching tool_results, and vice versa.
// OpenAI / Anthropic / Gemini all 400 on unpaired tool turns.
// For a multi-call assistant turn, if ANY of its tool_calls is unmatched, drop the whole turn
// (partial assistant turns would leave a dangling structure the provider can't parse).
function pairSafeMessages(messages) {
  // Two-pass: first compute which assistant tool-call turns survive (all their tool_calls
  // have matching results). Then collect the ids belonging to surviving turns — tool_result
  // messages outside that set become orphans (their turn was dropped) and are filtered too.
  const resultIds = new Set();
  for (const m of messages) {
    if (m.role === "tool" && m.toolCallId) resultIds.add(m.toolCallId);
  }
  const survivingIds = new Set();
  for (const m of messages) {
    if (m.isToolCall && Array.isArray(m.toolCalls)) {
      const allMatched = m.toolCalls.every(tc => tc && tc.id && resultIds.has(tc.id));
      if (allMatched) for (const tc of m.toolCalls) survivingIds.add(tc.id);
    }
  }

  return messages.filter(m => {
    if (m.role === "tool" && m.toolCallId) return survivingIds.has(m.toolCallId);
    if (m.isToolCall && Array.isArray(m.toolCalls)) {
      return m.toolCalls.every(tc => tc && tc.id && survivingIds.has(tc.id));
    }
    return true;
  });
}

// Take last `limit` messages; if the slice would start mid-pair
// (leading tool_result), extend backward to the preceding assistant tool-call turn.
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
    } else if (m.role === "assistant" && m.isToolCall && Array.isArray(m.toolCalls)) {
      out.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map(tc => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args || {})
          }
        }))
      });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: m.content || "" });
    } else if (m.role === "tool") {
      // OpenAI: each tool_result is its own message with role:"tool". Multiple consecutive is fine.
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
  // Anthropic requires all tool_result blocks for one assistant turn to be grouped into a
  // SINGLE subsequent user message's content array. Walk messages, detect each assistant
  // tool-call turn, collect the following role:"tool" messages, merge into one user turn.
  const out = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "user") {
      out.push({ role: "user", content: m.content || "" });
      i++;
    } else if (m.role === "assistant" && m.isToolCall && Array.isArray(m.toolCalls)) {
      // Thinking blocks must precede tool_use blocks for extended-thinking multi-turn.
      const blocks = [];
      for (const b of (m.thinkingBlocks || [])) {
        blocks.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
      }
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args || {} });
      }
      out.push({ role: "assistant", content: blocks });
      i++;
      // Merge subsequent tool-result messages into one user turn.
      const resultBlocks = [];
      while (i < messages.length && messages[i].role === "tool") {
        resultBlocks.push({
          type: "tool_result",
          tool_use_id: messages[i].toolCallId,
          content: JSON.stringify(messages[i].toolResult || {})
        });
        i++;
      }
      if (resultBlocks.length) out.push({ role: "user", content: resultBlocks });
    } else if (m.role === "assistant") {
      out.push({ role: "assistant", content: [{ type: "text", text: m.content || "" }] });
      i++;
    } else if (m.role === "tool") {
      // Orphan tool_result (shouldn't happen post pair-safe, but emit defensively).
      out.push({ role: "user", content: [{
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: JSON.stringify(m.toolResult || {})
      }] });
      i++;
    } else {
      i++;
    }
  }
  return out;
}

function historyToGemini(messages) {
  // Gemini: functionResponse parts of one turn group into a single user message's parts array.
  const out = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: m.content || "" }] });
      i++;
    } else if (m.role === "assistant" && m.isToolCall && Array.isArray(m.toolCalls)) {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.args || {} } });
      }
      out.push({ role: "model", parts });
      i++;
      const respParts = [];
      while (i < messages.length && messages[i].role === "tool") {
        const tm = messages[i];
        const response = (tm.toolResult && typeof tm.toolResult === "object")
          ? tm.toolResult
          : { result: tm.toolResult };
        respParts.push({ functionResponse: { name: tm.toolCallName, response } });
        i++;
      }
      if (respParts.length) out.push({ role: "user", parts: respParts });
    } else if (m.role === "assistant") {
      out.push({ role: "model", parts: [{ text: m.content || "" }] });
      i++;
    } else if (m.role === "tool") {
      const response = (m.toolResult && typeof m.toolResult === "object") ? m.toolResult : { result: m.toolResult };
      out.push({ role: "user", parts: [{ functionResponse: { name: m.toolCallName, response } }] });
      i++;
    } else {
      i++;
    }
  }
  // Gemini requires strict user/model alternation. If the assistant didn't emit a text
  // reply after a tool call (common — most fine-grained tools have silent results), we
  // end up with consecutive user turns: functionResponse user turn + next user text turn.
  // Merge runs of consecutive same-role turns into a single turn with concatenated parts.
  const merged = [];
  for (const turn of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === turn.role) {
      last.parts = last.parts.concat(turn.parts);
    } else {
      merged.push(turn);
    }
  }
  return merged;
}

function buildHistoryForProvider(messages, provider, limit = HISTORY_DEFAULT_LIMIT) {
  const filtered = filterInternalMessages(messages);
  const paired = pairSafeMessages(filtered);
  const truncated = truncatePreservingPairs(paired, limit);
  if (provider === "anthropic") return historyToAnthropic(truncated);
  if (provider === "gemini") return historyToGemini(truncated);
  return historyToOpenAI(truncated);
}
