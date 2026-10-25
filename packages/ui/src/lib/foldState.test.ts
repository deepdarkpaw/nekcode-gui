import { afterEach, describe, expect, it } from "vitest";
import {
  EMPTY_FOLD_SNAPSHOT,
  resolveFoldOpen,
  setFoldGroupMode,
  setFoldOverride,
  toggleFoldGroupMode,
  useFoldStore,
} from "./foldState.js";

describe("fold state resolution", () => {
  it("uses the caller default until the group is toggled globally", () => {
    expect(resolveFoldOpen(EMPTY_FOLD_SNAPSHOT, "tool-1", "toolOutput", true)).toBe(true);
    expect(resolveFoldOpen(EMPTY_FOLD_SNAPSHOT, "tool-2", "toolOutput", false)).toBe(false);
  });

  it("applies the global mode to every item of the group, overriding item defaults", () => {
    const expanded = toggleFoldGroupMode(EMPTY_FOLD_SNAPSHOT, "toolOutput");
    expect(resolveFoldOpen(expanded, "tool-1", "toolOutput", false)).toBe(true);
    const collapsed = toggleFoldGroupMode(expanded, "toolOutput");
    expect(resolveFoldOpen(collapsed, "tool-error", "toolOutput", true)).toBe(false);
    // 其他分组与无分组项不受影响
    expect(resolveFoldOpen(expanded, "think-1", "thinking", false)).toBe(false);
    expect(resolveFoldOpen(expanded, "msg-1", null, false)).toBe(false);
  });

  it("keeps manual overrides until the next global toggle of the same group", () => {
    let snapshot = setFoldGroupMode(EMPTY_FOLD_SNAPSHOT, "thinking", false);
    snapshot = setFoldOverride(snapshot, "think-1", "thinking", true);
    snapshot = setFoldOverride(snapshot, "tool-1", "toolOutput", true);
    expect(resolveFoldOpen(snapshot, "think-1", "thinking", false)).toBe(true);

    snapshot = toggleFoldGroupMode(snapshot, "toolOutput");
    expect(resolveFoldOpen(snapshot, "think-1", "thinking", false)).toBe(true);

    snapshot = setFoldGroupMode(snapshot, "thinking", false);
    expect(resolveFoldOpen(snapshot, "think-1", "thinking", true)).toBe(false);
    expect(snapshot.overrides.has("think-1")).toBe(false);
  });

  it("bounds overrides with LRU eviction", () => {
    let snapshot = EMPTY_FOLD_SNAPSHOT;
    for (let index = 0; index < 5; index += 1) {
      snapshot = setFoldOverride(snapshot, `row-${index}`, null, true, 3);
    }
    expect([...snapshot.overrides.keys()]).toEqual(["row-2", "row-3", "row-4"]);
    // 重新写入会刷新为最近使用
    snapshot = setFoldOverride(snapshot, "row-2", null, false, 3);
    snapshot = setFoldOverride(snapshot, "row-5", null, true, 3);
    expect([...snapshot.overrides.keys()]).toEqual(["row-4", "row-2", "row-5"]);
  });
});

describe("useFoldStore", () => {
  afterEach(() => useFoldStore.getState().reset());

  it("survives remounts because state lives in the module store", () => {
    useFoldStore.getState().setOpen("row-1", "toolOutput", true);
    expect(resolveFoldOpen(useFoldStore.getState(), "row-1", "toolOutput", false)).toBe(true);
    useFoldStore.getState().toggleGroup("toolOutput");
    const state = useFoldStore.getState();
    expect(state.groupModes.toolOutput).toBe(true);
    expect(state.overrides.size).toBe(0);
  });
});
