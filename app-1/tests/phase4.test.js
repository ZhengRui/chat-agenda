// Phase 4: history.js — internal messages ↔ provider-specific history
// Run: cd app-1 && node --test tests/phase4.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts } = require("./helpers");

const h = loadScripts(
  ["history.js"],
  [
    "filterInternalMessages",
    "pairSafeMessages",
    "truncatePreservingPairs",
    "historyToOpenAI",
    "historyToAnthropic",
    "historyToGemini",
    "buildHistoryForProvider"
  ]
);

// Helper: build a tool-call assistant message with toolCalls[] array shape.
const assistantToolCall = (toolCalls, extras = {}) => ({
  role: "assistant", isToolCall: true, toolCalls, thinkingBlocks: [], ...extras
});

// ---- filterInternalMessages ----

test("filter: drops info, error, streaming; keeps the rest", () => {
  const msgs = [
    { id: 1, role: "info", content: "loaded" },
    { id: 2, role: "user", content: "hi" },
    { id: 3, role: "assistant", content: "hello" },
    { id: 4, role: "assistant", content: "partial", streaming: true },
    { id: 5, role: "assistant", content: "boom", error: "api 500" },
    { id: 6, role: "user", content: "ok" }
  ];
  const out = h.filterInternalMessages(msgs);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(m => m.id), [2, 3, 6]);
});

// ---- pairSafeMessages ----

test("pair-safe: drops orphan assistant tool-call turn (no result)", () => {
  const msgs = [
    { id: 1, role: "user", content: "hi" },
    { id: 2, ...assistantToolCall([{ id: "orphan", name: "create_meeting", args: {} }]) },
    { id: 3, role: "user", content: "next" }
  ];
  const out = h.pairSafeMessages(msgs);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(m => m.id), [1, 3]);
});

test("pair-safe: drops orphan tool_result (no call)", () => {
  const msgs = [
    { id: 1, role: "tool", toolCallId: "ghost", toolResult: { success: true } },
    { id: 2, role: "user", content: "ok" }
  ];
  const out = h.pairSafeMessages(msgs);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 2);
});

test("pair-safe: keeps matched tool_call + tool_result pair", () => {
  const msgs = [
    { id: 1, role: "user", content: "plan" },
    { id: 2, ...assistantToolCall([{ id: "c1", name: "create_meeting", args: {} }]) },
    { id: 3, role: "tool", toolCallId: "c1", toolCallName: "create_meeting", toolResult: { success: true } }
  ];
  const out = h.pairSafeMessages(msgs);
  assert.equal(out.length, 3);
});

test("pair-safe: drops whole assistant turn if ANY of its tool_calls is unmatched", () => {
  const msgs = [
    { id: 1, role: "user", content: "plan" },
    // Two tool_calls in one turn, only one has a matching result → whole turn dropped.
    { id: 2, ...assistantToolCall([
      { id: "a", name: "swap_role", args: {} },
      { id: "b", name: "swap_role", args: {} }
    ]) },
    { id: 3, role: "tool", toolCallId: "a", toolResult: {} },
    { id: 4, role: "user", content: "next" }
  ];
  const out = h.pairSafeMessages(msgs);
  // id=2 (orphan turn) + id=3 (orphan result once turn is dropped) both gone.
  assert.deepEqual(out.map(m => m.id), [1, 4]);
});

test("pair-safe: multi-call assistant turn kept when ALL results present", () => {
  const msgs = [
    { id: 1, role: "user", content: "two at once" },
    { id: 2, ...assistantToolCall([
      { id: "a", name: "swap_role", args: {} },
      { id: "b", name: "set_duration", args: {} }
    ]) },
    { id: 3, role: "tool", toolCallId: "a", toolResult: {} },
    { id: 4, role: "tool", toolCallId: "b", toolResult: {} }
  ];
  const out = h.pairSafeMessages(msgs);
  assert.equal(out.length, 4);
});

// ---- truncatePreservingPairs ----

test("truncate: returns all when under limit", () => {
  const msgs = [{ role: "user", content: "a" }, { role: "user", content: "b" }];
  assert.equal(h.truncatePreservingPairs(msgs, 10).length, 2);
});

test("truncate: returns last N when over limit", () => {
  const msgs = Array.from({ length: 30 }, (_, i) => ({ role: "user", content: String(i) }));
  const out = h.truncatePreservingPairs(msgs, 10);
  assert.equal(out.length, 10);
  assert.equal(out[0].content, "20");
  assert.equal(out[9].content, "29");
});

test("truncate: walks back when slice would start with tool_result", () => {
  const head = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: "h" + i }));
  const tail = [
    assistantToolCall([{ id: "x1", name: "f", args: {} }]),
    { role: "tool", toolCallId: "x1", toolResult: {} },
    { role: "user", content: "after" }
  ];
  const out = h.truncatePreservingPairs([...head, ...tail], 2);
  assert.equal(out[0].isToolCall, true);
  assert.equal(out[out.length - 1].content, "after");
});

// ---- historyToOpenAI ----

test("OpenAI map: single tool_call turn → one assistant message with tool_calls[]", () => {
  const msgs = [
    { role: "user", content: "plan it" },
    assistantToolCall([{ id: "c1", name: "create_meeting", args: { raw_text: "txt" } }]),
    { role: "tool", toolCallId: "c1", toolResult: { success: true, summary: { no: 387 } } },
    { role: "assistant", content: "done" }
  ];
  const out = h.historyToOpenAI(msgs);
  assert.equal(out.length, 4);
  assert.equal(out[0].role, "user");
  assert.equal(out[1].role, "assistant");
  assert.equal(out[1].content, null);
  assert.equal(out[1].tool_calls.length, 1);
  assert.equal(out[1].tool_calls[0].id, "c1");
  assert.equal(out[1].tool_calls[0].type, "function");
  assert.equal(out[1].tool_calls[0].function.name, "create_meeting");
  assert.equal(typeof out[1].tool_calls[0].function.arguments, "string");
  assert.deepEqual(JSON.parse(out[1].tool_calls[0].function.arguments), { raw_text: "txt" });
  assert.equal(out[2].role, "tool");
  assert.equal(out[2].tool_call_id, "c1");
  assert.equal(JSON.parse(out[2].content).summary.no, 387);
  assert.equal(out[3].content, "done");
});

test("OpenAI map: multi tool_call turn → one assistant message with multiple tool_calls", () => {
  const msgs = [
    { role: "user", content: "two at once" },
    assistantToolCall([
      { id: "a", name: "swap_role", args: { segment_id: "s5", new_role_taker: "Jake" } },
      { id: "b", name: "set_duration", args: { segment_id: "s9", new_duration_min: 18 } }
    ]),
    { role: "tool", toolCallId: "a", toolResult: { success: true } },
    { role: "tool", toolCallId: "b", toolResult: { success: true } }
  ];
  const out = h.historyToOpenAI(msgs);
  // One assistant message + two separate tool messages
  assert.equal(out.length, 4);
  assert.equal(out[1].tool_calls.length, 2);
  assert.equal(out[1].tool_calls[0].function.name, "swap_role");
  assert.equal(out[1].tool_calls[1].function.name, "set_duration");
  assert.equal(out[2].role, "tool");
  assert.equal(out[2].tool_call_id, "a");
  assert.equal(out[3].tool_call_id, "b");
});

// ---- historyToAnthropic ----

test("Anthropic map: thinking + tool_use blocks in one assistant content array", () => {
  const msgs = [
    { role: "user", content: "plan" },
    assistantToolCall(
      [{ id: "c1", name: "create_meeting", args: { raw_text: "txt" } }],
      { thinkingBlocks: [{ thinking: "reasoning...", signature: "sig_abc" }] }
    ),
    { role: "tool", toolCallId: "c1", toolResult: { ok: 1 } }
  ];
  const out = h.historyToAnthropic(msgs);
  const assistant = out[1];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content[0].type, "thinking");
  assert.equal(assistant.content[0].signature, "sig_abc");
  assert.equal(assistant.content[1].type, "tool_use");
  assert.equal(assistant.content[1].id, "c1");
  assert.equal(assistant.content[1].input.raw_text, "txt");
  // Tool result merged into a user message
  assert.equal(out[2].role, "user");
  assert.equal(out[2].content[0].type, "tool_result");
  assert.equal(out[2].content[0].tool_use_id, "c1");
});

test("Anthropic map: multi tool_use blocks + grouped tool_results in one user turn", () => {
  const msgs = [
    { role: "user", content: "two at once" },
    assistantToolCall([
      { id: "a", name: "swap_role", args: { segment_id: "s5" } },
      { id: "b", name: "set_duration", args: { segment_id: "s9" } }
    ]),
    { role: "tool", toolCallId: "a", toolResult: { success: true } },
    { role: "tool", toolCallId: "b", toolResult: { success: true } }
  ];
  const out = h.historyToAnthropic(msgs);
  // Expected: user -> assistant(with 2 tool_use) -> user(with 2 tool_result)
  assert.equal(out.length, 3);
  assert.equal(out[1].content.filter(b => b.type === "tool_use").length, 2);
  assert.equal(out[2].role, "user");
  assert.equal(out[2].content.length, 2);
  assert.equal(out[2].content[0].type, "tool_result");
  assert.equal(out[2].content[0].tool_use_id, "a");
  assert.equal(out[2].content[1].tool_use_id, "b");
});

test("Anthropic map: assistant text with no tool_call → content: [{type:text}]", () => {
  const out = h.historyToAnthropic([{ role: "assistant", content: "hi" }]);
  assert.deepEqual({ ...out[0].content[0] }, { type: "text", text: "hi" });
});

test("Anthropic map: interleaved text + tool_use preserved", () => {
  const out = h.historyToAnthropic([
    assistantToolCall(
      [{ id: "c", name: "adjust_meeting", args: {} }],
      { content: "Let me handle that." }
    )
  ]);
  assert.equal(out[0].content[0].type, "text");
  assert.equal(out[0].content[0].text, "Let me handle that.");
  assert.equal(out[0].content[1].type, "tool_use");
});

// ---- historyToGemini ----

test("Gemini map: assistant becomes role:model; user stays user", () => {
  const out = h.historyToGemini([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" }
  ]);
  assert.equal(out[0].role, "user");
  assert.equal(out[0].parts[0].text, "hi");
  assert.equal(out[1].role, "model");
  assert.equal(out[1].parts[0].text, "hello");
});

test("Gemini map: functionCall and functionResponse with object-wrapped response", () => {
  const out = h.historyToGemini([
    assistantToolCall([{ id: "c1", name: "create_meeting", args: { raw_text: "x" } }]),
    { role: "tool", toolCallId: "c1", toolCallName: "create_meeting", toolResult: { success: true, summary: { no: 1 } } }
  ]);
  assert.equal(out[0].role, "model");
  assert.equal(out[0].parts[0].functionCall.name, "create_meeting");
  assert.equal(out[0].parts[0].functionCall.args.raw_text, "x");
  assert.equal(out[1].role, "user");
  const resp = out[1].parts[0].functionResponse;
  assert.equal(resp.name, "create_meeting");
  assert.equal(resp.response.summary.no, 1);
});

test("Gemini map: multi functionCall + grouped functionResponse parts", () => {
  const out = h.historyToGemini([
    assistantToolCall([
      { id: "a", name: "swap_role", args: { segment_id: "s5" } },
      { id: "b", name: "set_duration", args: { segment_id: "s9" } }
    ]),
    { role: "tool", toolCallId: "a", toolCallName: "swap_role", toolResult: { success: true } },
    { role: "tool", toolCallId: "b", toolCallName: "set_duration", toolResult: { success: true } }
  ]);
  // Expected: model(with 2 functionCall parts) -> user(with 2 functionResponse parts)
  assert.equal(out.length, 2);
  assert.equal(out[0].role, "model");
  assert.equal(out[0].parts.filter(p => p.functionCall).length, 2);
  assert.equal(out[1].role, "user");
  assert.equal(out[1].parts.length, 2);
  assert.equal(out[1].parts[0].functionResponse.name, "swap_role");
  assert.equal(out[1].parts[1].functionResponse.name, "set_duration");
});

test("Gemini map: merges consecutive user turns (functionResponse + next user text)", () => {
  // Regression: Gemini rejects contents with two user turns in a row. When an assistant
  // tool call isn't followed by a text reply (typical for fine-grained tools), the
  // functionResponse user turn is immediately followed by the NEXT user's text turn.
  // Expect them merged into a single user turn with both parts.
  const out = h.historyToGemini([
    { role: "user", content: "delete s25" },
    assistantToolCall([{ id: "a", name: "remove_segment", args: { segment_id: "s25" } }]),
    { role: "tool", toolCallId: "a", toolCallName: "remove_segment", toolResult: { success: true } },
    { role: "user", content: "now delete all buffers" }
  ]);
  // Expected turns: user(text) -> model(functionCall) -> user(functionResponse + text)
  assert.equal(out.length, 3);
  assert.equal(out[0].role, "user");
  assert.equal(out[1].role, "model");
  assert.equal(out[2].role, "user");
  // Merged user turn carries BOTH the functionResponse and the next user's text.
  assert.equal(out[2].parts.length, 2);
  assert.ok(out[2].parts[0].functionResponse);
  assert.equal(out[2].parts[0].functionResponse.name, "remove_segment");
  assert.equal(out[2].parts[1].text, "now delete all buffers");
});

test("Gemini map: role alternation holds across multiple silent tool rounds", () => {
  // Longer scenario: two tool rounds in a row with no text replies. Must still
  // alternate user/model strictly after merging.
  const out = h.historyToGemini([
    { role: "user", content: "u1" },
    assistantToolCall([{ id: "a1", name: "set_role", args: {} }]),
    { role: "tool", toolCallId: "a1", toolCallName: "set_role", toolResult: { ok: 1 } },
    { role: "user", content: "u2" },
    assistantToolCall([{ id: "a2", name: "set_role", args: {} }]),
    { role: "tool", toolCallId: "a2", toolCallName: "set_role", toolResult: { ok: 1 } },
    { role: "user", content: "u3" }
  ]);
  // Every adjacent pair must differ in role.
  for (let i = 1; i < out.length; i++) {
    assert.notEqual(out[i].role, out[i - 1].role, `roles at ${i - 1}/${i} must alternate`);
  }
});

test("Gemini map: non-object toolResult gets wrapped as { result: ... }", () => {
  const out = h.historyToGemini([
    { role: "tool", toolCallId: "c1", toolCallName: "x", toolResult: "plain string" }
  ]);
  assert.deepEqual({ ...out[0].parts[0].functionResponse.response }, { result: "plain string" });
});

// ---- buildHistoryForProvider integration ----

test("buildHistoryForProvider: full pipeline — filter + pair-safe + truncate + map", () => {
  const msgs = [
    { id: 1, role: "info", content: "loaded demo" },
    { id: 2, role: "user", content: "hi" },
    { id: 3, role: "assistant", content: "partial", streaming: true },
    { id: 4, ...assistantToolCall([{ id: "orphan", name: "x", args: {} }]) },
    { id: 5, role: "user", content: "plan" },
    { id: 6, ...assistantToolCall(
      [{ id: "c1", name: "create_meeting", args: { raw_text: "r" } }],
      { thinkingBlocks: [{ thinking: "t", signature: "s" }] }
    ) },
    { id: 7, role: "tool", toolCallId: "c1", toolCallName: "create_meeting", toolResult: { success: true } }
  ];

  const oai = h.buildHistoryForProvider(msgs, "openai");
  assert.equal(oai.length, 4);
  assert.equal(oai[0].content, "hi");
  assert.equal(oai[1].content, "plan");
  assert.equal(oai[2].tool_calls[0].id, "c1");
  assert.equal(oai[3].role, "tool");

  const anth = h.buildHistoryForProvider(msgs, "anthropic");
  const a = anth.find(m => Array.isArray(m.content) && m.content.some(b => b.type === "tool_use"));
  assert.equal(a.content[0].type, "thinking");
  assert.equal(a.content[0].signature, "s");

  const gem = h.buildHistoryForProvider(msgs, "gemini");
  const g = gem.find(m => m.parts && m.parts.some(p => p.functionCall));
  assert.equal(g.parts[0].functionCall.name, "create_meeting");
  const gr = gem.find(m => m.parts && m.parts.some(p => p.functionResponse));
  assert.equal(typeof gr.parts[0].functionResponse.response, "object");
});

test("buildHistoryForProvider: respects custom limit and preserves pair at boundary", () => {
  const msgs = [];
  for (let i = 0; i < 30; i++) msgs.push({ id: i, role: "user", content: String(i) });
  msgs.push({ id: 100, ...assistantToolCall([{ id: "c", name: "f", args: {} }]) });
  msgs.push({ id: 101, role: "tool", toolCallId: "c", toolCallName: "f", toolResult: {} });

  const out = h.buildHistoryForProvider(msgs, "openai", 2);
  assert.equal(out.length, 2);
  assert.ok(out[0].tool_calls);
  assert.equal(out[1].role, "tool");
});
