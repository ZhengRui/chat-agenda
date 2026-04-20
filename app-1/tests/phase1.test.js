// Phase 1: tools.js + SYSTEM_PROMPT
// Run: cd app-1 && node --test tests/phase1.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readApp, loadScripts } = require("./helpers");

const loaded = loadScripts(
  ["prompts.js", "tools.js"],
  [
    "SYSTEM_PROMPT",
    "CLUB_MEMBERS",
    "PLAN_MEETING_DEVELOPER_PROMPT",
    "PLAN_MEETING_USER_PROMPT",
    "ADJUST_MEETING_DEVELOPER_PROMPT",
    "ADJUST_MEETING_USER_PROMPT",
    "TOOL_REGISTRY",
    "TOOLS_OPENAI",
    "TOOLS_ANTHROPIC",
    "TOOLS_GEMINI",
  ]
);

test("TOOL_REGISTRY has at least create_meeting and adjust_meeting", () => {
  assert.ok(Array.isArray(loaded.TOOL_REGISTRY));
  const names = loaded.TOOL_REGISTRY.map((t) => t.name);
  assert.ok(names.includes("create_meeting"));
  assert.ok(names.includes("adjust_meeting"));
});

test("Every registry entry has description + params + required", () => {
  for (const t of loaded.TOOL_REGISTRY) {
    assert.equal(typeof t.description, "string");
    assert.ok(t.description.length > 20, `${t.name} description too short`);
    assert.equal(typeof t.params, "object");
    assert.ok(Array.isArray(t.required));
  }
});

test("OpenAI adapter: type=function, parameters.type lowercase", () => {
  const t = loaded.TOOLS_OPENAI[0];
  assert.equal(t.type, "function");
  assert.equal(t.function.name, "create_meeting");
  assert.equal(typeof t.function.description, "string");
  assert.equal(t.function.parameters.type, "object");
  assert.equal(t.function.parameters.properties.raw_text.type, "string");
  assert.ok(t.function.parameters.required.includes("raw_text"));
});

test("Anthropic adapter: input_schema.type=object", () => {
  const t = loaded.TOOLS_ANTHROPIC[0];
  assert.equal(t.name, "create_meeting");
  assert.equal(typeof t.description, "string");
  assert.equal(t.input_schema.type, "object");
  assert.equal(t.input_schema.properties.raw_text.type, "string");
  assert.ok(t.input_schema.required.includes("raw_text"));
});

test("Gemini adapter: all types uppercase (OBJECT/STRING), wrapped in functionDeclarations", () => {
  assert.equal(loaded.TOOLS_GEMINI.length, 1);
  const decls = loaded.TOOLS_GEMINI[0].functionDeclarations;
  assert.ok(Array.isArray(decls));
  const d = decls[0];
  assert.equal(d.name, "create_meeting");
  assert.equal(d.parameters.type, "OBJECT");
  assert.equal(d.parameters.properties.raw_text.type, "STRING");
  assert.ok(d.parameters.required.includes("raw_text"));
});

test("adjust_meeting present and consistent across all three schemas", () => {
  assert.equal(loaded.TOOLS_OPENAI[1].function.name, "adjust_meeting");
  assert.equal(loaded.TOOLS_ANTHROPIC[1].name, "adjust_meeting");
  assert.equal(
    loaded.TOOLS_GEMINI[0].functionDeclarations[1].name,
    "adjust_meeting"
  );
  // The required-field name should match across formats.
  // Spread to normalise sandbox-origin arrays for strict deepEqual.
  assert.deepEqual([...loaded.TOOLS_OPENAI[1].function.parameters.required], ["request"]);
  assert.deepEqual([...loaded.TOOLS_ANTHROPIC[1].input_schema.required], ["request"]);
  assert.deepEqual(
    [...loaded.TOOLS_GEMINI[0].functionDeclarations[1].parameters.required],
    ["request"]
  );
});

test("SYSTEM_PROMPT exists, non-trivial, mentions both tools and at least one no-tool case", () => {
  assert.equal(typeof loaded.SYSTEM_PROMPT, "string");
  assert.ok(loaded.SYSTEM_PROMPT.length > 200, "SYSTEM_PROMPT too short");
  assert.ok(loaded.SYSTEM_PROMPT.includes("create_meeting"));
  assert.ok(loaded.SYSTEM_PROMPT.includes("adjust_meeting"));
  // Must explicitly tell the model when NOT to call a tool.
  assert.match(loaded.SYSTEM_PROMPT, /do not|don't|NOT/i);
});

test("Legacy prompts still exported unchanged", () => {
  assert.equal(typeof loaded.PLAN_MEETING_DEVELOPER_PROMPT, "string");
  assert.equal(typeof loaded.PLAN_MEETING_USER_PROMPT, "string");
  assert.equal(typeof loaded.ADJUST_MEETING_DEVELOPER_PROMPT, "string");
  assert.equal(typeof loaded.ADJUST_MEETING_USER_PROMPT, "string");
  assert.ok(Array.isArray(loaded.CLUB_MEMBERS));
  assert.ok(loaded.CLUB_MEMBERS.length >= 10);
});

test("meeting-flow.html: tools.js tag is present AND after prompts.js", () => {
  const html = readApp("meeting-flow.html");
  const pIdx = html.indexOf('<script src="prompts.js"></script>');
  const tIdx = html.indexOf('<script src="tools.js"></script>');
  assert.ok(pIdx > 0, "prompts.js script tag missing");
  assert.ok(tIdx > 0, "tools.js script tag missing");
  assert.ok(tIdx > pIdx, "tools.js must load after prompts.js");
});
