import { describe, expect, it } from "vitest";
import {
  mergeQueuedIntoDraft,
  planQueueEdit,
  resolveDequeueShortcut,
  resolveQueueEditKey,
} from "./queue.js";

describe("queue logic", () => {
  it("QB-queue: merges an empty queue without changing the draft", () => {
    expect(mergeQueuedIntoDraft({ steering: [], followUp: [] }, "draft")).toBe("draft");
  });

  it("QB-queue: retrieves steering then follow-up before an existing draft", () => {
    expect(
      mergeQueuedIntoDraft({ steering: ["urgent", "also urgent"], followUp: ["later"] }, "draft"),
    ).toBe("urgent\n\nalso urgent\n\nlater\n\ndraft");
    expect(mergeQueuedIntoDraft({ steering: ["urgent"], followUp: [] }, "")).toBe("urgent");
  });

  it("QB-edit: edits a target in steering using actual queue contents", () => {
    expect(
      planQueueEdit(
        { steering: ["a", "b"], followUp: ["c"] },
        { kind: "steering", text: "b", occurrence: 0 },
        { type: "replace", text: "edited" },
      ),
    ).toEqual({ ok: true, requeue: { steering: ["a", "edited"], followUp: ["c"] } });
  });

  it("QB-edit: deletes a target in follow-up", () => {
    expect(
      planQueueEdit(
        { steering: ["a"], followUp: ["b", "c"] },
        { kind: "followUp", text: "b", occurrence: 0 },
        { type: "delete" },
      ),
    ).toEqual({ ok: true, requeue: { steering: ["a"], followUp: ["c"] } });
  });

  it("QB-edit: uses occurrence to edit the second duplicate", () => {
    expect(
      planQueueEdit(
        { steering: ["same", "same", "last"], followUp: [] },
        { kind: "steering", text: "same", occurrence: 1 },
        { type: "replace", text: "second" },
      ),
    ).toEqual({ ok: true, requeue: { steering: ["same", "second", "last"], followUp: [] } });
  });

  it("QB-edit: returns consumed and restores actual queue when the target was consumed", () => {
    const actual = { steering: ["new"], followUp: ["later"] };
    expect(
      planQueueEdit(actual, { kind: "steering", text: "old", occurrence: 0 }, { type: "delete" }),
    ).toEqual({ ok: false, reason: "consumed", requeue: actual });
  });

  it("QB-K1: recognizes Alt+ArrowUp and rejects IME or other modifiers", () => {
    expect(resolveDequeueShortcut({ key: "ArrowUp", altKey: true })).toBe(true);
    expect(resolveDequeueShortcut({ key: "ArrowUp", altKey: true, isComposing: true })).toBe(false);
    expect(resolveDequeueShortcut({ key: "ArrowUp", altKey: true, keyCode: 229 })).toBe(false);
    expect(resolveDequeueShortcut({ key: "ArrowUp", altKey: true, shiftKey: true })).toBe(false);
  });

  it("QB-K2: recognizes Enter submit and Escape cancel, including IME no-op", () => {
    expect(resolveQueueEditKey({ key: "Enter" })).toBe("submit");
    expect(resolveQueueEditKey({ key: "Escape" })).toBe("cancel");
    expect(resolveQueueEditKey({ key: "Enter", isComposing: true })).toBeNull();
    expect(resolveQueueEditKey({ key: "Escape", keyCode: 229 })).toBeNull();
    expect(resolveQueueEditKey({ key: "Tab" })).toBeNull();
  });
});
