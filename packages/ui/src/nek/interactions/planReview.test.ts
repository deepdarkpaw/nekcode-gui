import { describe, expect, it } from "vitest";
import type { NekPlanReviewPayload } from "@zcode/shared/nek-protocol";
import { buildPlanReviewResult } from "./structuredResults.js";
import { resolvePlanReviewKey } from "./planReviewKeyboard.js";
import {
  createPlanReviewState,
  planBodyDefaultOpen,
  reducePlanReview,
} from "./planReviewReducer.js";

const payload: NekPlanReviewPayload = {
  path: "/workspace/plan.md",
  revision: 3,
  name: "Build it",
  overview: "A concise plan.",
  markdown: "# Plan\n\n- Do it",
  todos: [{ id: "one", content: "Do it" }],
};

function key(patch: Partial<Parameters<typeof resolvePlanReviewKey>[0]>) {
  return {
    key: "?",
    focusTarget: "card" as const,
    ...patch,
  };
}

describe("plan review", () => {
  it("PR-A1/PR-A2/PR-A3/PR-A4: builds the four wire actions", () => {
    expect(buildPlanReviewResult("implement")).toEqual({ action: "implement" });
    expect(buildPlanReviewResult("implement_fresh")).toEqual({ action: "implement_fresh" });
    expect(buildPlanReviewResult("keep_planning")).toEqual({ action: "keep_planning" });
    expect(buildPlanReviewResult("exit")).toEqual({ action: "exit" });
  });

  it("PR-2.2: defaults body open through 40 lines and collapsed after that", () => {
    expect(planBodyDefaultOpen("one\ntwo")).toBe(true);
    expect(
      planBodyDefaultOpen(Array.from({ length: 41 }, (_, index) => String(index)).join("\n")),
    ).toBe(false);
    expect(createPlanReviewState(payload.markdown).expanded).toBe(true);
  });

  it("PR-2.3: reducer toggles body and rejects mutations after close", () => {
    const initial = createPlanReviewState(payload.markdown);
    const collapsed = reducePlanReview(initial, { type: "toggleBody" });
    expect(collapsed.expanded).toBe(false);
    const closed = reducePlanReview(collapsed, { type: "close" });
    expect(reducePlanReview(closed, { type: "toggleBody" })).toBe(closed);
  });
});

describe("plan review keyboard", () => {
  it.each([
    ["PR-K3: Ctrl Enter", key({ key: "Enter", ctrlKey: true }), "implement"],
    ["PR-K3: Cmd Enter", key({ key: "Enter", metaKey: true }), "implement"],
    ["PR-K4: Escape", key({ key: "Escape" }), "later"],
  ])("%s", (_name, input, expected) => {
    expect(resolvePlanReviewKey(input)).toBe(expected);
  });

  it("PR-K1/PR-K2/PR-K5/PR-K6: focus and reading keys stay native", () => {
    expect(resolvePlanReviewKey(key({ key: "Enter", focusTarget: "button" }))).toBeNull();
    expect(resolvePlanReviewKey(key({ key: "1" }))).toBeNull();
    expect(resolvePlanReviewKey(key({ key: "ArrowDown" }))).toBeNull();
    expect(resolvePlanReviewKey(key({ key: "PageDown" }))).toBeNull();
    expect(resolvePlanReviewKey(key({ key: " ", focusTarget: "multiline" }))).toBeNull();
  });

  it("PR-K7: IME never handles approval keys", () => {
    expect(resolvePlanReviewKey(key({ key: "Escape", isComposing: true }))).toBeNull();
    expect(resolvePlanReviewKey(key({ key: "Enter", keyCode: 229, ctrlKey: true }))).toBeNull();
  });
});
