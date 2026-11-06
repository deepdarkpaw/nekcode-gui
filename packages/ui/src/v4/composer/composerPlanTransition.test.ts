import { expect, it } from "vitest";
import { applyComposerPlanTransition } from "./composerPlanTransition.js";
import type { V4ComposerDraft } from "./composerDraftStore.js";

it("P5: accepted Plan/Agent changes update both the selector and the next submission", () => {
  const draft: V4ComposerDraft = {
    text: "draft stays",
    updatedAt: 1,
    mode: "agent",
    planEnabled: false,
  };
  const planning = applyComposerPlanTransition(draft, { toolCallId: "enter", planEnabled: true });
  expect(planning.mode).toBe("plan");
  expect(planning.planEnabled).toBe(true);
  const implementing = applyComposerPlanTransition(planning, {
    toolCallId: "execute",
    planEnabled: false,
  });
  expect(implementing.mode).toBe("agent");
  expect(implementing.planEnabled).toBe(false);
  expect(implementing.text).toBe(draft.text);
  const userChanged = { ...implementing, mode: "plan" as const, planEnabled: true };
  expect(
    applyComposerPlanTransition(userChanged, { toolCallId: "execute", planEnabled: false }),
  ).toBe(userChanged);
});
