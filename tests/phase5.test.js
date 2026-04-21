// Phase 5: timing.js — segment time-shift semantics
// Run: node --test tests/phase5.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadScripts } = require("./helpers");

const timing = loadScripts(
  ["timing.js"],
  ["minutesLabel", "analyzeShiftSegment", "buildShiftConflictResult"]
);

const seg = (overrides = {}) => ({
  id: "s1",
  type: "Prepared Speech",
  bufferBefore: 0,
  ...overrides
});

test("minutesLabel formats integer minutes", () => {
  assert.equal(timing.minutesLabel(1), "1 min");
  assert.equal(timing.minutesLabel(5), "5 min");
  assert.equal(timing.minutesLabel(-3), "3 min");
});

test("analyzeShiftSegment: later shifts are always allowed", () => {
  const out = timing.analyzeShiftSegment([seg({ bufferBefore: 2 })], 0, 4);
  assert.equal(out.ok, true);
  assert.equal(out.direction, "later");
  assert.equal(out.requestedDeltaMin, 4);
});

test("analyzeShiftSegment: earlier shift within gap is allowed", () => {
  const out = timing.analyzeShiftSegment([seg(), seg({ id: "s2", bufferBefore: 3 })], 1, -2);
  assert.equal(out.ok, true);
  assert.equal(out.direction, "earlier");
  assert.equal(out.availableGapMin, 3);
});

test("analyzeShiftSegment: earlier shift beyond gap is rejected", () => {
  const out = timing.analyzeShiftSegment([seg(), seg({ id: "s2", bufferBefore: 2 })], 1, -5);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "insufficient_gap");
  assert.equal(out.availableGapMin, 2);
  assert.equal(out.shortageMin, 3);
});

test("analyzeShiftSegment: first segment cannot move earlier on its own", () => {
  const out = timing.analyzeShiftSegment([seg({ bufferBefore: 0 })], 0, -1);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "first_segment");
  assert.match(out.error, /first segment/i);
});

test("analyzeShiftSegment: negative overlap does not count as available earlier gap", () => {
  const out = timing.analyzeShiftSegment([seg(), seg({ id: "s2", bufferBefore: -2 })], 1, -1);
  assert.equal(out.ok, false);
  assert.equal(out.availableGapMin, 0);
});

test("buildShiftConflictResult: insufficient gap returns actionable suggestions", () => {
  const analysis = timing.analyzeShiftSegment([seg(), seg({ id: "s2", bufferBefore: 1 })], 1, -3);
  const result = timing.buildShiftConflictResult(seg({ id: "s2" }), analysis);
  assert.equal(result.success, false);
  assert.equal(result.segment_id, "s2");
  assert.equal(result.max_earlier_min, 1);
  assert.ok(Array.isArray(result.suggestions));
  assert.match(result.user_message, /up to 1 min/i);
});

test("buildShiftConflictResult: first segment points user to meeting start time", () => {
  const analysis = timing.analyzeShiftSegment([seg({ id: "s9" })], 0, -2);
  const result = timing.buildShiftConflictResult(seg({ id: "s9", type: "Opening Remarks" }), analysis);
  assert.equal(result.success, false);
  assert.match(result.user_message, /meeting start time/i);
  assert.match(result.suggestions[0], /start time/i);
});
