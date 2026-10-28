import { describe, expect, it } from "vitest";
import {
  createConfirmState,
  createEditorState,
  createInputState,
  createSelectState,
  filterSelectOptions,
  reduceEditor,
  reduceInput,
  reduceSelect,
  resolveConfirmKey,
  resolveEditorKey,
  resolveInputKey,
  resolveSelectKey,
} from "./extensionDialog.js";

const selectKey = (patch: Partial<Parameters<typeof resolveSelectKey>[0]>) => ({
  key: "?",
  focusTarget: "filter" as const,
  filter: "",
  highlighted: 0,
  ...patch,
});

describe("extension dialog pure logic", () => {
  it("ED-S1/ED-S4/ED-S5: filters in original order and moves/highlights rows", () => {
    expect(filterSelectOptions(["Alpha", "beta", "alphabet"], "AL")).toEqual([
      { value: "Alpha", index: 0 },
      { value: "alphabet", index: 2 },
    ]);
    let state = createSelectState();
    state = reduceSelect(state, { type: "move", delta: -1, itemCount: 2 });
    expect(state.highlighted).toBe(1);
    state = reduceSelect(state, { type: "highlight", index: 0, itemCount: 2 });
    expect(state.highlighted).toBe(0);
  });

  it("ED-S2/ED-S3/ED-S6: select keyboard table leaves Home/End native", () => {
    expect(resolveSelectKey(selectKey({ key: "ArrowDown" }))).toBe("next");
    expect(resolveSelectKey(selectKey({ key: "ArrowUp" }))).toBe("previous");
    expect(resolveSelectKey(selectKey({ key: "Enter" }))).toBe("select");
    expect(resolveSelectKey(selectKey({ key: "Enter", highlighted: -1 }))).toBe("noop");
    expect(resolveSelectKey(selectKey({ key: "Escape", filter: "x" }))).toBe("clearFilter");
    expect(resolveSelectKey(selectKey({ key: "Escape" }))).toBe("cancel");
    expect(resolveSelectKey(selectKey({ key: "Home" }))).toBeNull();
    expect(resolveSelectKey(selectKey({ key: "End" }))).toBeNull();
  });

  it("ED-4.1/ED-4.2: select IME and non-filter targets are native", () => {
    expect(resolveSelectKey(selectKey({ key: "Enter", isComposing: true }))).toBeNull();
    expect(resolveSelectKey(selectKey({ key: "Escape", focusTarget: "button" }))).toBeNull();
  });

  it("ED-C1/ED-C2/ED-C3: confirm defaults safe and Escape cancels", () => {
    expect(createConfirmState()).toEqual({ closed: false });
    expect(resolveConfirmKey({ key: "Escape", focusTarget: "card" })).toBe("cancel");
    expect(resolveConfirmKey({ key: "Enter", focusTarget: "button" })).toBeNull();
    expect(resolveConfirmKey({ key: "Escape", keyCode: 229, focusTarget: "card" })).toBeNull();
  });

  it("ED-I1/ED-I2: input accepts empty submit and uses IME-safe keys", () => {
    expect(createInputState().text).toBe("");
    expect(resolveInputKey({ key: "Enter", focusTarget: "input" })).toBe("submit");
    expect(resolveInputKey({ key: "Escape", focusTarget: "input" })).toBe("cancel");
    expect(resolveInputKey({ key: "Enter", isComposing: true, focusTarget: "input" })).toBeNull();
    const changed = reduceInput(createInputState(), { type: "setText", text: "value" });
    expect(changed.text).toBe("value");
  });

  it("ED-E1/ED-E2/ED-E3: editor Enter/newline, modified Enter submit, and discard guard", () => {
    const initial = createEditorState("prefill");
    expect(
      resolveEditorKey({ key: "Enter", focusTarget: "editor", confirmDiscard: false }),
    ).toBeNull();
    expect(
      resolveEditorKey({
        key: "Enter",
        ctrlKey: true,
        focusTarget: "editor",
        confirmDiscard: false,
      }),
    ).toBe("submit");
    expect(resolveEditorKey({ key: "Escape", focusTarget: "editor", confirmDiscard: false })).toBe(
      "cancel",
    );
    expect(resolveEditorKey({ key: "Escape", focusTarget: "editor", confirmDiscard: true })).toBe(
      "keepEditing",
    );
    const dirty = reduceEditor(initial, { type: "setText", text: "changed" });
    expect(reduceEditor(dirty, { type: "requestCancel" }).confirmDiscard).toBe(true);
    expect(reduceEditor(dirty, { type: "requestCancel" }).closed).toBe(false);
    expect(reduceEditor(dirty, { type: "discard" }).closed).toBe(true);
  });
});
