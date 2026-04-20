// Phase 3: builders.js — capability helpers + body builders with tools
// Run: cd app-1 && node --test tests/phase3.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts } = require("./helpers");

const b = loadScripts(
  ["prompts.js", "tools.js", "builders.js"],
  [
    "isReasoningModel", "mustThink", "effectiveThinking",
    "anthropicUsesAdaptive", "anthropicBudget",
    "geminiUses3x", "geminiLevel", "geminiBudget",
    "buildOpenAIBody", "buildAnthropicBody", "buildGeminiBody",
    "TOOLS_OPENAI", "TOOLS_ANTHROPIC", "TOOLS_GEMINI"
  ]
);

// Fixtures.
const cfg = (overrides = {}) => ({
  apiKey: "test",
  baseUrl: "https://example",
  model: "gpt-5.4-nano",
  reasoningEffort: "high",
  thinkingEnabled: true,
  ...overrides
});
const msgs = [{ role: "user", content: "hi" }];

// ---- Capability helpers ----

test("isReasoningModel: matches o-series and gpt-5.x", () => {
  assert.equal(b.isReasoningModel("o1"), true);
  assert.equal(b.isReasoningModel("o3-mini"), true);
  assert.equal(b.isReasoningModel("gpt-5.4"), true);
  assert.equal(b.isReasoningModel("gpt-5.4-nano"), true);
  assert.equal(b.isReasoningModel("gpt-4-turbo"), false);
  assert.equal(b.isReasoningModel("claude-haiku-4-5"), false);
});

test("mustThink: per-provider forced-thinking models", () => {
  assert.equal(b.mustThink("openai", "o3"), true);
  assert.equal(b.mustThink("openai", "gpt-5.4"), false);
  assert.equal(b.mustThink("anthropic", "claude-mythos-preview"), true);
  assert.equal(b.mustThink("anthropic", "claude-opus-4-7"), false);
  assert.equal(b.mustThink("gemini", "gemini-3.1-pro-preview"), true);
  assert.equal(b.mustThink("gemini", "gemini-3-deep-think"), true);
  assert.equal(b.mustThink("gemini", "gemini-2.5-flash-lite"), false);
  assert.equal(b.mustThink("deepseek", "model1"), false);
});

test("effectiveThinking: mustThink forces on; else follows thinkingEnabled", () => {
  assert.equal(b.effectiveThinking("openai", { model: "o3", thinkingEnabled: false }), true);
  assert.equal(b.effectiveThinking("openai", { model: "gpt-5.4", thinkingEnabled: false }), false);
  assert.equal(b.effectiveThinking("openai", { model: "gpt-5.4", thinkingEnabled: true }), true);
  assert.equal(b.effectiveThinking("openai", { model: "gpt-5.4" }), true); // undefined = on
});

test("anthropicUsesAdaptive: opus-4-7 / opus-4-6 / sonnet-4-6 / mythos", () => {
  assert.equal(b.anthropicUsesAdaptive("claude-opus-4-7"), true);
  assert.equal(b.anthropicUsesAdaptive("claude-opus-4-6"), true);
  assert.equal(b.anthropicUsesAdaptive("claude-sonnet-4-6"), true);
  assert.equal(b.anthropicUsesAdaptive("claude-mythos-preview"), true);
  assert.equal(b.anthropicUsesAdaptive("claude-haiku-4-5"), false);
});

test("anthropicBudget: maps effort to budget_tokens with sane fallback", () => {
  assert.equal(b.anthropicBudget("low"), 1024);
  assert.equal(b.anthropicBudget("max"), 14000);
  assert.equal(b.anthropicBudget("unknown"), 8192); // fallback = high
});

test("geminiLevel / geminiBudget / geminiUses3x", () => {
  assert.equal(b.geminiUses3x("gemini-3.1-pro-preview"), true);
  assert.equal(b.geminiUses3x("gemini-2.5-flash-lite"), false);
  assert.equal(b.geminiLevel("xhigh"), "high");  // cap
  assert.equal(b.geminiLevel("max"), "high");
  assert.equal(b.geminiLevel("low"), "low");
  assert.equal(b.geminiBudget("max"), -1);       // dynamic
  assert.equal(b.geminiBudget("medium"), 8192);
});

// ---- buildOpenAIBody ----

test("OpenAI builder: includeTools=true attaches tools and tool_choice=auto", () => {
  const body = b.buildOpenAIBody("openai", cfg(), msgs, true, true);
  assert.equal(body.tool_choice, "auto");
  assert.ok(Array.isArray(body.tools) && body.tools.length >= 2);
  assert.equal(body.tools[0].function.name, "create_meeting");
});

test("OpenAI builder: includeTools=false omits tools field", () => {
  const body = b.buildOpenAIBody("openai", cfg(), msgs, true, false);
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
});

test("OpenAI builder: reasoning model + thinking on → reasoning_effort set, no temperature", () => {
  const body = b.buildOpenAIBody("openai", cfg({ model: "gpt-5.4-nano", reasoningEffort: "high" }), msgs, true);
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.temperature, undefined);
});

test("OpenAI builder: max effort maps to xhigh (OpenAI has no 'max')", () => {
  const body = b.buildOpenAIBody("openai", cfg({ reasoningEffort: "max" }), msgs, true);
  assert.equal(body.reasoning_effort, "xhigh");
});

test("OpenAI builder: reasoning model + thinking off → reasoning_effort:none, temperature 0.3", () => {
  const body = b.buildOpenAIBody("openai", cfg({ thinkingEnabled: false }), msgs, true);
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.temperature, 0.3);
});

test("OpenAI builder: non-reasoning model → temperature 0.3, no reasoning_effort", () => {
  const body = b.buildOpenAIBody("openai", cfg({ model: "gpt-4-turbo" }), msgs, true);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.temperature, 0.3);
});

test("OpenAI builder: DeepSeek branch attaches thinking field and keeps temperature", () => {
  const body = b.buildOpenAIBody("deepseek", cfg({ model: "model1", reasoningEffort: "max" }), msgs, true);
  assert.deepEqual({ ...body.thinking }, { type: "enabled" });
  assert.equal(body.reasoning_effort, "max");
  assert.equal(body.temperature, 0.3);
  // DeepSeek body should have no max_completion_tokens (no enforced limit).
  assert.equal(body.max_completion_tokens, undefined);
});

test("OpenAI builder: DeepSeek with thinking off omits thinking/reasoning_effort but keeps tools", () => {
  const body = b.buildOpenAIBody("deepseek", cfg({ model: "model1", thinkingEnabled: false }), msgs, true, true);
  assert.equal(body.thinking, undefined);
  assert.equal(body.reasoning_effort, undefined);
  assert.ok(Array.isArray(body.tools));
});

// ---- buildAnthropicBody ----

test("Anthropic builder: includeTools=true attaches tools; no tool_choice field", () => {
  const body = b.buildAnthropicBody(cfg({ model: "claude-haiku-4-5" }), "sys", msgs, true, true);
  assert.ok(Array.isArray(body.tools) && body.tools.length >= 2);
  assert.equal(body.tools[0].name, "create_meeting");
  // Anthropic has no tool_choice default required.
});

test("Anthropic builder: includeTools=false omits tools", () => {
  const body = b.buildAnthropicBody(cfg({ model: "claude-haiku-4-5" }), "sys", msgs, true, false);
  assert.equal(body.tools, undefined);
});

test("Anthropic builder: opus-4-7 uses adaptive thinking with output_config.effort", () => {
  const body = b.buildAnthropicBody(cfg({ model: "claude-opus-4-7", reasoningEffort: "high" }), "sys", msgs, true);
  assert.deepEqual({ ...body.thinking }, { type: "adaptive" });
  assert.equal(body.output_config.effort, "high");
  assert.equal(body.temperature, undefined);
});

test("Anthropic builder: haiku-4-5 uses enabled + budget_tokens", () => {
  const body = b.buildAnthropicBody(cfg({ model: "claude-haiku-4-5", reasoningEffort: "medium" }), "sys", msgs, true);
  assert.equal(body.thinking.type, "enabled");
  assert.equal(body.thinking.budget_tokens, 4096); // medium mapping
  assert.equal(body.temperature, undefined);
});

test("Anthropic builder: thinking off → type:disabled + temperature 0.3", () => {
  const body = b.buildAnthropicBody(cfg({ model: "claude-haiku-4-5", thinkingEnabled: false }), "sys", msgs, true);
  assert.equal(body.thinking.type, "disabled");
  assert.equal(body.temperature, 0.3);
  assert.equal(body.output_config, undefined);
});

// ---- buildGeminiBody ----

test("Gemini builder: includeTools=true wraps functionDeclarations", () => {
  const contents = [{ role: "user", parts: [{ text: "hi" }] }];
  const body = b.buildGeminiBody(cfg({ model: "gemini-2.5-flash-lite" }), "sys", contents, true);
  assert.ok(Array.isArray(body.tools));
  assert.ok(body.tools[0].functionDeclarations[0].name === "create_meeting");
});

test("Gemini builder: 2.5 series uses thinkingBudget, 3.x uses thinkingLevel", () => {
  const contents = [{ role: "user", parts: [{ text: "hi" }] }];
  const body25 = b.buildGeminiBody(cfg({ model: "gemini-2.5-flash-lite", reasoningEffort: "high" }), "sys", contents, false);
  assert.equal(body25.generationConfig.thinkingConfig.thinkingBudget, 16384);
  assert.equal(body25.generationConfig.thinkingConfig.thinkingLevel, undefined);

  const body3 = b.buildGeminiBody(cfg({ model: "gemini-3-flash-preview", reasoningEffort: "high" }), "sys", contents, false);
  assert.equal(body3.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(body3.generationConfig.thinkingConfig.thinkingBudget, undefined);
});

test("Gemini builder: includeThoughts true when thinking on, false when off", () => {
  const contents = [{ role: "user", parts: [{ text: "hi" }] }];
  const on = b.buildGeminiBody(cfg({ model: "gemini-2.5-flash-lite", thinkingEnabled: true }), "sys", contents, false);
  const off = b.buildGeminiBody(cfg({ model: "gemini-2.5-flash-lite", thinkingEnabled: false }), "sys", contents, false);
  assert.equal(on.generationConfig.thinkingConfig.includeThoughts, true);
  assert.equal(off.generationConfig.thinkingConfig.includeThoughts, false);
  assert.equal(off.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(off.generationConfig.temperature, 0.3);
});

test("Gemini builder: system_instruction.parts is an array (spec form)", () => {
  const contents = [{ role: "user", parts: [{ text: "hi" }] }];
  const body = b.buildGeminiBody(cfg({ model: "gemini-2.5-flash-lite" }), "sys", contents, false);
  assert.ok(Array.isArray(body.system_instruction.parts));
  assert.equal(body.system_instruction.parts[0].text, "sys");
});

// ---- Defaults ----

test("All builders default includeTools to true when omitted", () => {
  const oai = b.buildOpenAIBody("openai", cfg(), msgs, true);
  const anth = b.buildAnthropicBody(cfg({ model: "claude-haiku-4-5" }), "sys", msgs, true);
  const gem = b.buildGeminiBody(cfg({ model: "gemini-2.5-flash-lite" }), "sys", [{ role: "user", parts: [{ text: "x" }] }]);
  assert.ok(Array.isArray(oai.tools));
  assert.ok(Array.isArray(anth.tools));
  assert.ok(Array.isArray(gem.tools));
});
