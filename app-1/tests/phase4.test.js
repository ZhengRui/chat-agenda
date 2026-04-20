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

test("pair-safe: drops orphan tool_call (no result)", () => {
  const msgs = [
    { id: 1, role: "user", content: "hi" },
    { id: 2, role: "assistant", isToolCall: true, toolCallId: "orphan", toolCallName: "create_meeting", toolCallArgs: {} },
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
    { id: 2, role: "assistant", isToolCall: true, toolCallId: "c1", toolCallName: "create_meeting", toolCallArgs: {} },
    { id: 3, role: "tool", toolCallId: "c1", toolCallName: "create_meeting", toolResult: { success: true } }
  ];
  const out = h.pairSafeMessages(msgs);
  assert.equal(out.length, 3);
});

test("pair-safe: mixed orphans + valid pairs", () => {
  const msgs = [
    { id: 1, role: "assistant", isToolCall: true, toolCallId: "a", toolCallName: "x", toolCallArgs: {} },  // orphan
    { id: 2, role: "user", content: "hi" },
    { id: 3, role: "assistant", isToolCall: true, toolCallId: "b", toolCallName: "y", toolCallArgs: {} },  // valid
    { id: 4, role: "tool", toolCallId: "b", toolResult: {} },                                              // valid
    { id: 5, role: "tool", toolCallId: "c", toolResult: {} }                                               // orphan
  ];
  const out = h.pairSafeMessages(msgs);
  assert.deepEqual(out.map(m => m.id), [2, 3, 4]);
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
  // Ten unrelated + [tc, tr, user] at end. Limit=2 would start at tr; should walk back to tc.
  const head = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: "h" + i }));
  const tail = [
    { role: "assistant", isToolCall: true, toolCallId: "x1", toolCallName: "f", toolCallArgs: {} },
    { role: "tool", toolCallId: "x1", toolResult: {} },
    { role: "user", content: "after" }
  ];
  const out = h.truncatePreservingPairs([...head, ...tail], 2);
  // Naive slice would give [tool, user]; walked back should give [tool_call, tool, user] = 3 items.
  assert.equal(out[0].isToolCall, true);
  assert.equal(out[out.length - 1].content, "after");
});

// ---- historyToOpenAI ----

test("OpenAI map: user / assistant text / assistant tool_call / tool_result", () => {
  const msgs = [
    { role: "user", content: "plan it" },
    { role: "assistant", isToolCall: true, toolCallId: "c1", toolCallName: "create_meeting", toolCallArgs: { raw_text: "txt" } },
    { role: "tool", toolCallId: "c1", toolResult: { success: true, summary: { no: 387 } } },
    { role: "assistant", content: "done" }
  ];
  const out = h.historyToOpenAI(msgs);
  assert.equal(out.length, 4);
  assert.equal(out[0].role, "user");
  assert.equal(out[0].content, "plan it");
  assert.equal(out[1].role, "assistant");
  assert.equal(out[1].content, null);
  assert.equal(out[1].tool_calls[0].id, "c1");
  assert.equal(out[1].tool_calls[0].type, "function");
  assert.equal(out[1].tool_calls[0].function.name, "create_meeting");
  // arguments must be a JSON string, not an object
  assert.equal(typeof out[1].tool_calls[0].function.arguments, "string");
  assert.deepEqual(JSON.parse(out[1].tool_calls[0].function.arguments), { raw_text: "txt" });
  assert.equal(out[2].role, "tool");
  assert.equal(out[2].tool_call_id, "c1");
  assert.equal(typeof out[2].content, "string");
  assert.equal(JSON.parse(out[2].content).summary.no, 387);
  assert.equal(out[3].role, "assistant");
  assert.equal(out[3].content, "done");
});

// ---- historyToAnthropic ----

test("Anthropic map: thinking blocks precede tool_use in assistant turn", () => {
  const msgs = [
    { role: "user", content: "plan" },
    {
      role: "assistant",
      isToolCall: true,
      toolCallId: "c1",
      toolCallName: "create_meeting",
      toolCallArgs: { raw_text: "txt" },
      thinkingBlocks: [{ thinking: "reasoning...", signature: "sig_abc" }]
    },
    { role: "tool", toolCallId: "c1", toolResult: { ok: 1 } }
  ];
  const out = h.historyToAnthropic(msgs);
  assert.equal(out[0].role, "user");
  assert.equal(out[0].content, "plan");
  // Assistant content must be array with thinking FIRST, then tool_use
  const assistant = out[1];
  assert.equal(assistant.role, "assistant");
  assert.ok(Array.isArray(assistant.content));
  assert.equal(assistant.content[0].type, "thinking");
  assert.equal(assistant.content[0].thinking, "reasoning...");
  assert.equal(assistant.content[0].signature, "sig_abc");
  assert.equal(assistant.content[1].type, "tool_use");
  assert.equal(assistant.content[1].id, "c1");
  assert.equal(assistant.content[1].name, "create_meeting");
  assert.equal(assistant.content[1].input.raw_text, "txt");
  // Tool result must be role:user with tool_result block
  assert.equal(out[2].role, "user");
  assert.equal(out[2].content[0].type, "tool_result");
  assert.equal(out[2].content[0].tool_use_id, "c1");
  assert.equal(typeof out[2].content[0].content, "string");
});

test("Anthropic map: assistant text with no tool_call → content: [{type:text}]", () => {
  const out = h.historyToAnthropic([{ role: "assistant", content: "hi" }]);
  assert.equal(out[0].role, "assistant");
  assert.deepEqual({ ...out[0].content[0] }, { type: "text", text: "hi" });
});

test("Anthropic map: interleaved text + tool_use preserved", () => {
  const out = h.historyToAnthropic([{
    role: "assistant", isToolCall: true, content: "Let me handle that.",
    toolCallId: "c", toolCallName: "adjust_meeting", toolCallArgs: {},
    thinkingBlocks: []
  }]);
  // Expect: [text, tool_use]
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
    { role: "assistant", isToolCall: true, toolCallId: "c1", toolCallName: "create_meeting", toolCallArgs: { raw_text: "x" } },
    { role: "tool", toolCallId: "c1", toolCallName: "create_meeting", toolResult: { success: true, summary: { no: 1 } } }
  ]);
  assert.equal(out[0].role, "model");
  assert.equal(out[0].parts[0].functionCall.name, "create_meeting");
  assert.equal(out[0].parts[0].functionCall.args.raw_text, "x");
  assert.equal(out[1].role, "user");
  const resp = out[1].parts[0].functionResponse;
  assert.equal(resp.name, "create_meeting");
  assert.equal(typeof resp.response, "object");
  assert.equal(resp.response.summary.no, 1);
});

test("Gemini map: non-object toolResult gets wrapped as { result: ... }", () => {
  const out = h.historyToGemini([
    { role: "tool", toolCallId: "c1", toolCallName: "x", toolResult: "plain string" }
  ]);
  // This message has no matching tool_call in this test — we're calling the mapper directly,
  // which doesn't do pair-safety. We just want to verify the wrapping.
  assert.deepEqual({ ...out[0].parts[0].functionResponse.response }, { result: "plain string" });
});

// ---- buildHistoryForProvider integration ----

test("buildHistoryForProvider: full pipeline — filter + pair-safe + truncate + map", () => {
  const msgs = [
    { id: 1, role: "info", content: "loaded demo" },                                   // filtered out
    { id: 2, role: "user", content: "hi" },
    { id: 3, role: "assistant", content: "partial", streaming: true },                  // filtered out
    { id: 4, role: "assistant", isToolCall: true, toolCallId: "orphan", toolCallName: "x", toolCallArgs: {} }, // orphan
    { id: 5, role: "user", content: "plan" },
    { id: 6, role: "assistant", isToolCall: true, toolCallId: "c1", toolCallName: "create_meeting", toolCallArgs: { raw_text: "r" }, thinkingBlocks: [{ thinking: "t", signature: "s" }] },
    { id: 7, role: "tool", toolCallId: "c1", toolCallName: "create_meeting", toolResult: { success: true } }
  ];

  const oai = h.buildHistoryForProvider(msgs, "openai");
  assert.equal(oai.length, 4);               // filtered info + streaming + orphan tool_call
  assert.equal(oai[0].content, "hi");
  assert.equal(oai[1].content, "plan");
  assert.equal(oai[2].tool_calls[0].id, "c1");
  assert.equal(oai[3].role, "tool");

  const anth = h.buildHistoryForProvider(msgs, "anthropic");
  // Anthropic assistant tool_use turn includes thinking block
  const a = anth.find(m => Array.isArray(m.content) && m.content.some(b => b.type === "tool_use"));
  assert.equal(a.content[0].type, "thinking");
  assert.equal(a.content[0].signature, "s");

  const gem = h.buildHistoryForProvider(msgs, "gemini");
  const g = gem.find(m => m.parts && m.parts[0].functionCall);
  assert.equal(g.parts[0].functionCall.name, "create_meeting");
  const gr = gem.find(m => m.parts && m.parts[0].functionResponse);
  assert.equal(typeof gr.parts[0].functionResponse.response, "object");
});

test("buildHistoryForProvider: respects custom limit and preserves pair at boundary", () => {
  const msgs = [];
  for (let i = 0; i < 30; i++) msgs.push({ id: i, role: "user", content: String(i) });
  // Append one complete pair at the end
  msgs.push({ id: 100, role: "assistant", isToolCall: true, toolCallId: "c", toolCallName: "f", toolCallArgs: {} });
  msgs.push({ id: 101, role: "tool", toolCallId: "c", toolCallName: "f", toolResult: {} });

  const out = h.buildHistoryForProvider(msgs, "openai", 2);
  // Last 2 = [tool_call, tool_result]; pair intact, slice doesn't start with orphan tool_result.
  assert.equal(out.length, 2);
  assert.ok(out[0].tool_calls);
  assert.equal(out[1].role, "tool");
});
