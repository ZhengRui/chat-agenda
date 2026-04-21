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
  const oai = loaded.TOOLS_OPENAI.find(t => t.function.name === "adjust_meeting");
  const anth = loaded.TOOLS_ANTHROPIC.find(t => t.name === "adjust_meeting");
  const gem = loaded.TOOLS_GEMINI[0].functionDeclarations.find(d => d.name === "adjust_meeting");
  assert.ok(oai && anth && gem, "adjust_meeting missing from one or more adapters");
  // Spread to normalise sandbox-origin arrays for strict deepEqual.
  assert.deepEqual([...oai.function.parameters.required], ["request"]);
  assert.deepEqual([...anth.input_schema.required], ["request"]);
  assert.deepEqual([...gem.parameters.required], ["request"]);
});

test("Fine-grained tools present across all three adapters", () => {
  const FINE = ["set_role", "set_type", "swap_roles", "set_duration", "add_segment", "remove_segment", "move_segment", "swap_time", "set_buffer", "set_meta"];
  for (const name of FINE) {
    const inReg = loaded.TOOL_REGISTRY.some(t => t.name === name);
    const inOai = loaded.TOOLS_OPENAI.some(t => t.function.name === name);
    const inAnth = loaded.TOOLS_ANTHROPIC.some(t => t.name === name);
    const inGem = loaded.TOOLS_GEMINI[0].functionDeclarations.some(d => d.name === name);
    assert.ok(inReg, `${name} missing from TOOL_REGISTRY`);
    assert.ok(inOai, `${name} missing from TOOLS_OPENAI`);
    assert.ok(inAnth, `${name} missing from TOOLS_ANTHROPIC`);
    assert.ok(inGem, `${name} missing from TOOLS_GEMINI`);
  }
});

test("add_segment exposes after_id + before_id (optional) and type/duration_min required", () => {
  const add = loaded.TOOL_REGISTRY.find(t => t.name === "add_segment");
  assert.ok(add.params.after_id && add.params.before_id);
  assert.deepEqual([...add.required].sort(), ["duration_min", "type"]);
});

test("set_meta params expose a single field + value, both required", () => {
  const sm = loaded.TOOL_REGISTRY.find(t => t.name === "set_meta");
  assert.ok(sm.params.field && sm.params.value);
  assert.deepEqual([...sm.required].sort(), ["field", "value"]);
});

test("Gemini keeps uppercase types for all fine-grained tools", () => {
  const decls = loaded.TOOLS_GEMINI[0].functionDeclarations;
  for (const d of decls) {
    assert.equal(d.parameters.type, "OBJECT", `${d.name}: parameters.type should be OBJECT`);
    for (const [name, prop] of Object.entries(d.parameters.properties)) {
      assert.ok(prop.type === prop.type.toUpperCase(), `${d.name}.${name}: type ${prop.type} should be uppercase`);
    }
  }
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

test("chat-agenda.html: tools.js tag is present AND after prompts.js", () => {
  const html = readApp("chat-agenda.html");
  const pIdx = html.indexOf('<script src="prompts.js"></script>');
  const tIdx = html.indexOf('<script src="tools.js"></script>');
  assert.ok(pIdx > 0, "prompts.js script tag missing");
  assert.ok(tIdx > 0, "tools.js script tag missing");
  assert.ok(tIdx > pIdx, "tools.js must load after prompts.js");
});
