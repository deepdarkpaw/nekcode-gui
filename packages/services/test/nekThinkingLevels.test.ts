import assert from "node:assert/strict";
import test from "node:test";
import type { NekModel } from "@zcode/shared/nek-protocol";
import { toCatalogModel } from "../src/nek-config-api/controlApi.js";

const model: NekModel = {
  id: "gpt-6.1-sol",
  name: "GPT",
  provider: "newapi",
  api: "openai-responses",
  baseUrl: "https://gateway.invalid/v1",
  input: ["text"],
  reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  thinkingLevelMap: { off: null, minimal: null },
};

test("TL1/TL2: available models do not advertise implicit xhigh/max", () => {
  assert.deepEqual(toCatalogModel(model).thinkingLevels, ["low", "medium", "high"]);
});

test("TL1/TL5: available models honor explicit, remapped and disabled advanced levels", () => {
  for (const thinkingLevelMap of [
    { ...model.thinkingLevelMap, xhigh: "xhigh", max: "max" },
    { ...model.thinkingLevelMap, xhigh: "very_high", max: "xhigh" },
    { ...model.thinkingLevelMap, xhigh: "", max: "" },
  ]) {
    assert.deepEqual(toCatalogModel({ ...model, thinkingLevelMap }).thinkingLevels, [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  }
  assert.deepEqual(
    toCatalogModel({ ...model, thinkingLevelMap: { ...model.thinkingLevelMap, max: null } })
      .thinkingLevels,
    ["low", "medium", "high"],
  );
  assert.deepEqual(toCatalogModel({ ...model, reasoning: false }).thinkingLevels, []);
});
