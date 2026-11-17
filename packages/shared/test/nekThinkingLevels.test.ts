import assert from "node:assert/strict";
import test from "node:test";
import { NEK_THINKING_LEVELS, nekThinkingLevelsFromMap } from "../src/nek-protocol/index.js";

test("TL1: absent map only supports the five implicit standard levels", () => {
  assert.deepEqual(nekThinkingLevelsFromMap(undefined), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(nekThinkingLevelsFromMap({ off: null, minimal: null }), [
    "low",
    "medium",
    "high",
  ]);
});

test("TL1: explicit strings, including remapped and empty values, opt into advanced levels", () => {
  for (const map of [
    { xhigh: "xhigh", max: "max" },
    { xhigh: "very_high", max: "xhigh" },
    { xhigh: "", max: "" },
  ]) {
    assert.deepEqual(nekThinkingLevelsFromMap(map), NEK_THINKING_LEVELS);
  }
});

test("TL1: null disables any level without mutating input or reordering enabled levels", () => {
  const map = Object.freeze({ high: null, xhigh: null, max: "max" });
  assert.deepEqual(nekThinkingLevelsFromMap(map), ["off", "minimal", "low", "medium", "max"]);
  assert.deepEqual(map, { high: null, xhigh: null, max: "max" });
  assert.notEqual(nekThinkingLevelsFromMap(map), nekThinkingLevelsFromMap(map));
});
