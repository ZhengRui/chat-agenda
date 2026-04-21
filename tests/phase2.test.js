// Phase 2: streaming.js SSE accumulation helpers
// Run: cd app-1 && node --test tests/phase2.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts } = require("./helpers");

const s = loadScripts(
  ["streaming.js"],
  [
    "parseSseLines",
    "isOpenAITerminalChunk",
    "isAnthropicTerminalEvent",
    "isGeminiTerminalChunk",
    "createOpenAIState", "handleOpenAIChunk", "finalizeOpenAIState",
    "createAnthropicState", "handleAnthropicEvent", "finalizeAnthropicState",
    "createGeminiState", "handleGeminiChunk", "finalizeGeminiState"
  ]
);

// ---- SSE line parsing ----

test("parseSseLines: splits events, keeps partial trailing line in remainder", () => {
  const buf = `data: {"a":1}\ndata: {"b":2}\ndata: {"c":`;
  const { events, remainder, sawDone } = s.parseSseLines(buf);
  assert.equal(events.length, 2);
  assert.equal(events[0].a, 1);
  assert.equal(events[1].b, 2);
  assert.equal(remainder, `data: {"c":`);
  assert.equal(sawDone, false);
});

test("parseSseLines: reports [DONE], skips blank lines and malformed JSON", () => {
  const buf = `data: [DONE]\n\ndata: {bad\ndata: {"ok":true}\n`;
  const { events, remainder, sawDone } = s.parseSseLines(buf);
  assert.equal(events.length, 1);
  assert.equal(events[0].ok, true);
  assert.equal(remainder, "");
  assert.equal(sawDone, true);
});

test("terminal detectors: OpenAI, Anthropic, Gemini", () => {
  assert.equal(s.isOpenAITerminalChunk({ choices: [{ finish_reason: "stop" }] }), true);
  assert.equal(s.isOpenAITerminalChunk({ choices: [{ finish_reason: null }] }), false);

  assert.equal(s.isAnthropicTerminalEvent({ type: "message_stop" }), true);
  assert.equal(s.isAnthropicTerminalEvent({ type: "content_block_stop" }), false);

  assert.equal(s.isGeminiTerminalChunk({ candidates: [{ finishReason: "STOP" }] }), true);
  assert.equal(s.isGeminiTerminalChunk({ promptFeedback: { blockReason: "SAFETY" } }), true);
  assert.equal(s.isGeminiTerminalChunk({ candidates: [{ content: { parts: [{ text: "x" }] } }] }), false);
});

// ---- OpenAI / DeepSeek ----

function openAIDelta(delta, index = 0) {
  return { choices: [{ index, delta }] };
}

test("OpenAI: plain content streams to onContent and accumulates", () => {
  const st = s.createOpenAIState();
  const out = [];
  s.handleOpenAIChunk(st, openAIDelta({ content: "Hello " }), () => {}, c => out.push(c));
  s.handleOpenAIChunk(st, openAIDelta({ content: "world" }), () => {}, c => out.push(c));
  const r = s.finalizeOpenAIState(st);
  assert.equal(r.content, "Hello world");
  assert.equal(out.join(""), "Hello world");
  assert.equal(r.toolCalls.length, 0);
});

test("OpenAI: reasoning_content and reasoning both route to onThinking", () => {
  const st = s.createOpenAIState();
  const out = [];
  s.handleOpenAIChunk(st, openAIDelta({ reasoning_content: "step 1 " }), t => out.push(t), () => {});
  s.handleOpenAIChunk(st, openAIDelta({ reasoning: "step 2" }), t => out.push(t), () => {});
  assert.equal(out.join(""), "step 1 step 2");
});

test("OpenAI: single tool_call reassembled across multiple deltas", () => {
  const st = s.createOpenAIState();
  const chunks = [
    openAIDelta({ tool_calls: [{ index: 0, id: "call_x", function: { name: "create_meeting" } }] }),
    openAIDelta({ tool_calls: [{ index: 0, function: { arguments: '{"raw_te' } }] }),
    openAIDelta({ tool_calls: [{ index: 0, function: { arguments: 'xt":"hello"}' } }] }),
  ];
  for (const c of chunks) s.handleOpenAIChunk(st, c, () => {}, () => {});
  const r = s.finalizeOpenAIState(st);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].id, "call_x");
  assert.equal(r.toolCalls[0].name, "create_meeting");
  assert.deepEqual({ ...r.toolCalls[0].args }, { raw_text: "hello" });
});

test("OpenAI: parallel tool_calls keyed by index, ordered by index", () => {
  const st = s.createOpenAIState();
  // Interleave deltas for index 0 and index 1.
  s.handleOpenAIChunk(st, openAIDelta({ tool_calls: [{ index: 1, id: "b", function: { name: "adjust_meeting", arguments: '{"request":"x"}' } }] }), () => {}, () => {});
  s.handleOpenAIChunk(st, openAIDelta({ tool_calls: [{ index: 0, id: "a", function: { name: "create_meeting", arguments: '{"raw_text":"y"}' } }] }), () => {}, () => {});
  const r = s.finalizeOpenAIState(st);
  assert.equal(r.toolCalls.length, 2);
  assert.equal(r.toolCalls[0].id, "a");
  assert.equal(r.toolCalls[1].id, "b");
});

test("OpenAI: malformed tool_call args surface as __parseError (no crash)", () => {
  const st = s.createOpenAIState();
  s.handleOpenAIChunk(st, openAIDelta({ tool_calls: [{ index: 0, id: "c1", function: { name: "create_meeting", arguments: "{not json" } }] }), () => {}, () => {});
  const r = s.finalizeOpenAIState(st);
  assert.equal(r.toolCalls[0].args.__parseError !== undefined, true);
  assert.equal(r.toolCalls[0].args.__raw, "{not json");
});

// ---- Anthropic ----

test("Anthropic: text_delta streams and accumulates content", () => {
  const st = s.createAnthropicState();
  const out = [];
  const onContent = c => out.push(c);
  s.handleAnthropicEvent(st, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, () => {}, onContent);
  s.handleAnthropicEvent(st, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi " } }, () => {}, onContent);
  s.handleAnthropicEvent(st, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there" } }, () => {}, onContent);
  s.handleAnthropicEvent(st, { type: "content_block_stop", index: 0 }, () => {}, onContent);
  const r = s.finalizeAnthropicState(st);
  assert.equal(r.content, "Hi there");
  assert.equal(out.join(""), "Hi there");
  assert.equal(r.toolCalls.length, 0);
  assert.equal(r.thinkingBlocks.length, 0);
});

test("Anthropic: thinking block accumulates thinking + signature", () => {
  const st = s.createAnthropicState();
  const onThinking = () => {};
  s.handleAnthropicEvent(st, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, onThinking, () => {});
  s.handleAnthropicEvent(st, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me reason " } }, onThinking, () => {});
  s.handleAnthropicEvent(st, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "about this" } }, onThinking, () => {});
  s.handleAnthropicEvent(st, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_abc" } }, onThinking, () => {});
  s.handleAnthropicEvent(st, { type: "content_block_stop", index: 0 }, onThinking, () => {});
  const r = s.finalizeAnthropicState(st);
  assert.equal(r.thinkingBlocks.length, 1);
  assert.equal(r.thinkingBlocks[0].thinking, "let me reason about this");
  assert.equal(r.thinkingBlocks[0].signature, "sig_abc");
});

test("Anthropic: tool_use block reassembles partial_json into args", () => {
  const st = s.createAnthropicState();
  s.handleAnthropicEvent(st, { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_123", name: "create_meeting" } }, () => {}, () => {});
  s.handleAnthropicEvent(st, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"raw_text":' } }, () => {}, () => {});
  s.handleAnthropicEvent(st, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"hello"}' } }, () => {}, () => {});
  s.handleAnthropicEvent(st, { type: "content_block_stop", index: 1 }, () => {}, () => {});
  const r = s.finalizeAnthropicState(st);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].id, "toolu_123");
  assert.equal(r.toolCalls[0].name, "create_meeting");
  assert.deepEqual({ ...r.toolCalls[0].args }, { raw_text: "hello" });
});

test("Anthropic: thinking + text + tool_use in same response, all preserved", () => {
  const st = s.createAnthropicState();
  const thOut = [], ctOut = [];
  const onT = t => thOut.push(t);
  const onC = c => ctOut.push(c);
  // Thinking
  s.handleAnthropicEvent(st, { type: "content_block_start", index: 0, content_block: { type: "thinking" } }, onT, onC);
  s.handleAnthropicEvent(st, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thinking..." } }, onT, onC);
  s.handleAnthropicEvent(st, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig1" } }, onT, onC);
  s.handleAnthropicEvent(st, { type: "content_block_stop", index: 0 }, onT, onC);
  // Text
  s.handleAnthropicEvent(st, { type: "content_block_start", index: 1, content_block: { type: "text" } }, onT, onC);
  s.handleAnthropicEvent(st, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Here you go." } }, onT, onC);
  s.handleAnthropicEvent(st, { type: "content_block_stop", index: 1 }, onT, onC);
  // Tool use
  s.handleAnthropicEvent(st, { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "t1", name: "adjust_meeting" } }, onT, onC);
  s.handleAnthropicEvent(st, { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"request":"go"}' } }, onT, onC);
  s.handleAnthropicEvent(st, { type: "content_block_stop", index: 2 }, onT, onC);

  const r = s.finalizeAnthropicState(st);
  assert.equal(r.thinkingBlocks.length, 1);
  assert.equal(r.thinkingBlocks[0].signature, "sig1");
  assert.equal(r.content, "Here you go.");
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, "adjust_meeting");
  assert.equal(thOut.join(""), "thinking...");
  assert.equal(ctOut.join(""), "Here you go.");
});

// ---- Gemini ----

function geminiChunk(parts) {
  return { candidates: [{ content: { parts } }] };
}

test("Gemini: text parts accumulate into content", () => {
  const st = s.createGeminiState();
  const out = [];
  s.handleGeminiChunk(st, geminiChunk([{ text: "hello " }]), () => {}, c => out.push(c));
  s.handleGeminiChunk(st, geminiChunk([{ text: "world" }]), () => {}, c => out.push(c));
  const r = s.finalizeGeminiState(st);
  assert.equal(r.content, "hello world");
  assert.equal(out.join(""), "hello world");
});

test("Gemini: thought parts route to onThinking and stay out of content", () => {
  const st = s.createGeminiState();
  const tOut = [], cOut = [];
  s.handleGeminiChunk(st, geminiChunk([{ thought: true, text: "reasoning..." }]), t => tOut.push(t), c => cOut.push(c));
  s.handleGeminiChunk(st, geminiChunk([{ text: "answer" }]), t => tOut.push(t), c => cOut.push(c));
  const r = s.finalizeGeminiState(st);
  assert.equal(tOut.join(""), "reasoning...");
  assert.equal(r.content, "answer");
});

test("Gemini: single-part functionCall preserves raw part + thoughtSignature", () => {
  const st = s.createGeminiState();
  s.handleGeminiChunk(st, geminiChunk([{
    functionCall: { name: "create_meeting", args: { raw_text: "x" } },
    thoughtSignature: "sig_a"
  }]), () => {}, () => {});
  const r = s.finalizeGeminiState(st);
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].name, "create_meeting");
  assert.deepEqual({ ...r.toolCalls[0].args }, { raw_text: "x" });
  assert.match(r.toolCalls[0].id, /^gemini_/);
  assert.equal(r.modelParts.length, 1);
  assert.equal(r.modelParts[0].thoughtSignature, "sig_a");
  assert.equal(r.modelParts[0].functionCall.name, "create_meeting");
  assert.equal(r.toolCalls[0].rawPart.thoughtSignature, "sig_a");
});

test("Gemini: repeated same-name functionCall parts produce separate tool_calls (parallel calls)", () => {
  // Previously these got merged by name — that collapsed real parallel calls
  // (e.g. two set_role for different segments) into one. Each functionCall part
  // is atomic, so treat them as independent tool_calls in arrival order.
  const st = s.createGeminiState();
  s.handleGeminiChunk(st, geminiChunk([{ functionCall: { name: "set_role", args: { segment_id: "s3", new_role_taker: "Frank" } } }]), () => {}, () => {});
  s.handleGeminiChunk(st, geminiChunk([{ functionCall: { name: "set_role", args: { segment_id: "s5", new_role_taker: "Joyce" } } }]), () => {}, () => {});
  const r = s.finalizeGeminiState(st);
  assert.equal(r.toolCalls.length, 2);
  assert.equal(r.toolCalls[0].args.segment_id, "s3");
  assert.equal(r.toolCalls[0].args.new_role_taker, "Frank");
  assert.equal(r.toolCalls[1].args.segment_id, "s5");
  assert.equal(r.toolCalls[1].args.new_role_taker, "Joyce");
});

test("Gemini: two different functionCalls produce two tool_calls in arrival order", () => {
  const st = s.createGeminiState();
  s.handleGeminiChunk(st, geminiChunk([{ functionCall: { name: "create_meeting", args: {} } }]), () => {}, () => {});
  s.handleGeminiChunk(st, geminiChunk([{ functionCall: { name: "adjust_meeting", args: {} } }]), () => {}, () => {});
  const r = s.finalizeGeminiState(st);
  assert.equal(r.toolCalls.length, 2);
  assert.equal(r.toolCalls[0].name, "create_meeting");
  assert.equal(r.toolCalls[1].name, "adjust_meeting");
});

test("Gemini: modelParts keep arrival order across text and functionCall parts", () => {
  const st = s.createGeminiState();
  s.handleGeminiChunk(st, geminiChunk([{ text: "Let me check." }]), () => {}, () => {});
  s.handleGeminiChunk(st, geminiChunk([{ functionCall: { name: "adjust_meeting", args: { request: "x" } }, thoughtSignature: "sig_b" }]), () => {}, () => {});
  const r = s.finalizeGeminiState(st);
  assert.equal(r.modelParts.length, 2);
  assert.equal(r.modelParts[0].text, "Let me check.");
  assert.equal(r.modelParts[1].functionCall.name, "adjust_meeting");
  assert.equal(r.modelParts[1].thoughtSignature, "sig_b");
});

// ---- Final shape consistency ----

test("All three finalize* return { content, toolCalls, thinkingBlocks }", () => {
  for (const r of [
    s.finalizeOpenAIState(s.createOpenAIState()),
    s.finalizeAnthropicState(s.createAnthropicState()),
    s.finalizeGeminiState(s.createGeminiState())
  ]) {
    assert.equal(typeof r.content, "string");
    assert.ok(Array.isArray(r.toolCalls));
    assert.ok(Array.isArray(r.thinkingBlocks));
  }
});
