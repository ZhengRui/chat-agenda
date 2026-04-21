// ============================================================
// SSE parsing and tool_call / thinking_block accumulation.
// Pure functions — no DOM, no fetch. Browser scripts and Node
// tests both load this file directly.
// ============================================================

function clonePlainJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

// Split an SSE buffer into parsed `data:` JSON events plus any
// trailing partial line. Caller feeds the remainder back in next round.
// Non-JSON lines and comments are skipped silently. `[DONE]` is surfaced so
// callers can terminate even if the server keeps the SSE socket open.
function parseSseLines(buffer) {
  const lines = buffer.split("\n");
  const remainder = lines.pop() || "";
  const events = [];
  let sawDone = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data: ")) continue;
    const data = trimmed.slice(6);
    if (data === "[DONE]") {
      sawDone = true;
      continue;
    }
    try { events.push(JSON.parse(data)); } catch (_) { /* skip malformed */ }
  }
  return { events, remainder, sawDone };
}

function isOpenAITerminalChunk(chunk) {
  const choices = chunk?.choices;
  return Array.isArray(choices) && choices.some(choice => choice?.finish_reason != null);
}

function isAnthropicTerminalEvent(event) {
  return event?.type === "message_stop";
}

function isGeminiTerminalChunk(chunk) {
  if (chunk?.promptFeedback?.blockReason) return true;
  const candidates = chunk?.candidates;
  return Array.isArray(candidates) && candidates.some(candidate => candidate?.finishReason);
}

// ---- OpenAI / DeepSeek ----

function createOpenAIState() {
  return { content: "", toolCallsByIndex: new Map(), thinkingBlocks: [] };
}

function handleOpenAIChunk(state, chunk, onThinking, onContent) {
  const delta = chunk.choices?.[0]?.delta;
  if (!delta) return;
  if (delta.reasoning_content) onThinking(delta.reasoning_content);
  if (delta.reasoning) onThinking(delta.reasoning);
  if (delta.content) {
    state.content += delta.content;
    onContent(delta.content);
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      const idx = tc.index ?? 0;
      let acc = state.toolCallsByIndex.get(idx);
      if (!acc) {
        acc = { id: "", name: "", argsStr: "" };
        state.toolCallsByIndex.set(idx, acc);
      }
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name = tc.function.name;
      if (tc.function?.arguments) acc.argsStr += tc.function.arguments;
    }
  }
}

function finalizeOpenAIState(state) {
  const toolCalls = [];
  const keys = [...state.toolCallsByIndex.keys()].sort((a, b) => a - b);
  for (const k of keys) {
    const acc = state.toolCallsByIndex.get(k);
    let args = {};
    if (acc.argsStr) {
      try { args = JSON.parse(acc.argsStr); }
      catch (e) { args = { __parseError: e.message, __raw: acc.argsStr }; }
    }
    toolCalls.push({ id: acc.id, name: acc.name, args });
  }
  return { content: state.content, toolCalls, thinkingBlocks: state.thinkingBlocks };
}

// ---- Anthropic ----
// Events stream: content_block_start / content_block_delta / content_block_stop.
// Blocks can be of type "thinking", "text", or "tool_use", keyed by index.

function createAnthropicState() {
  return { content: "", blocks: {}, thinkingBlocks: [], toolCalls: [] };
}

function handleAnthropicEvent(state, event, onThinking, onContent) {
  const idx = event.index ?? 0;
  if (event.type === "content_block_start") {
    const b = event.content_block || {};
    if (b.type === "thinking") {
      state.blocks[idx] = { type: "thinking", thinking: b.thinking || "", signature: "" };
      if (b.thinking) onThinking(b.thinking);
    } else if (b.type === "tool_use") {
      state.blocks[idx] = { type: "tool_use", id: b.id || "", name: b.name || "", argsStr: "" };
    } else if (b.type === "text") {
      state.blocks[idx] = { type: "text", text: b.text || "" };
      if (b.text) { state.content += b.text; onContent(b.text); }
    }
    return;
  }
  if (event.type === "content_block_delta") {
    const block = state.blocks[idx];
    if (!block) return;
    const d = event.delta || {};
    if (d.type === "thinking_delta" && block.type === "thinking") {
      block.thinking += d.thinking || "";
      if (d.thinking) onThinking(d.thinking);
    } else if (d.type === "signature_delta" && block.type === "thinking") {
      block.signature += d.signature || "";
    } else if (d.type === "input_json_delta" && block.type === "tool_use") {
      block.argsStr += d.partial_json || "";
    } else if (d.type === "text_delta" && block.type === "text") {
      block.text += d.text || "";
      if (d.text) { state.content += d.text; onContent(d.text); }
    }
    return;
  }
  if (event.type === "content_block_stop") {
    const block = state.blocks[idx];
    if (!block) return;
    if (block.type === "thinking") {
      state.thinkingBlocks.push({ thinking: block.thinking, signature: block.signature });
    } else if (block.type === "tool_use") {
      let args = {};
      if (block.argsStr) {
        try { args = JSON.parse(block.argsStr); }
        catch (e) { args = { __parseError: e.message, __raw: block.argsStr }; }
      }
      state.toolCalls.push({ id: block.id, name: block.name, args });
    }
  }
}

function finalizeAnthropicState(state) {
  return { content: state.content, toolCalls: state.toolCalls, thinkingBlocks: state.thinkingBlocks };
}

// ---- Gemini ----
// Parts arrive inside candidates[0].content.parts. Each `functionCall` part is a
// complete atomic unit — do NOT merge by name, or parallel calls with the same
// tool (e.g. two set_role, two set_type) collapse into one.

function createGeminiState() {
  return {
    content: "",
    thinkingBlocks: [],
    toolCalls: [],
    modelParts: []
  };
}

function handleGeminiChunk(state, chunk, onThinking, onContent) {
  const parts = chunk.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return;
  for (const part of parts) {
    const rawPart = clonePlainJson(part);
    state.modelParts.push(rawPart);
    if (part.thought && part.text) {
      onThinking(part.text);
      // Gemini thought summaries carry no signature, so don't push into thinkingBlocks.
    } else if (part.text && !part.thought) {
      state.content += part.text;
      onContent(part.text);
    } else if (part.functionCall) {
      state.toolCalls.push({
        id: "gemini_" + Date.now() + "_" + state.toolCalls.length,
        name: part.functionCall.name,
        args: (part.functionCall.args && typeof part.functionCall.args === "object")
          ? { ...part.functionCall.args }
          : {},
        rawPart
      });
    }
  }
}

function finalizeGeminiState(state) {
  return {
    content: state.content,
    toolCalls: state.toolCalls,
    thinkingBlocks: state.thinkingBlocks,
    modelParts: state.modelParts
  };
}
