import { describe, expect, it } from "vitest";
import { readTaskSidePaneMemoryState, saveTaskSidePaneMemoryState } from "./taskSidePaneMemory.js";
import {
  activateGitSidePane,
  getVisibleSidePaneTabs,
  normalizeWorkspaceSidePaneState,
  openSubagentSessionSidePane,
  restoreSidePaneTab,
  shouldMountSidePaneContent,
  syncSubagentSessionSidePaneTabs,
  type WorkspaceSidePaneState,
} from "./workspaceSidePane.js";

const SUBAGENT_REQUEST = {
  workspaceKey: "remote-workspace",
  workspacePath: "/repo",
  workspaceIdentity: "remote-workspace",
  remoteSessionId: "ssh-connection",
  rootSessionId: "root",
  parentSessionId: "parent",
  childSessionId: "child",
  subagentType: "explorer",
  title: "Inspect source",
};

/** Model an older cache/schema entering the typed normalization boundary. */
function restoredState(tabs: unknown[], activeTabId: string): WorkspaceSidePaneState {
  return { tabs, activeTabId } as WorkspaceSidePaneState;
}

const RETIRED_DIRECTORY_TAB = {
  id: "old-directory",
  type: "subagent-directory",
  workspaceKey: "remote-workspace",
  workspacePath: "/repo",
  rootSessionId: "root",
  parentSessionId: "parent",
};

const SUPPORTED_TABS: WorkspaceSidePaneState["tabs"] = [
  { id: "git", type: "git" },
  { id: "developer-tools", type: "developer-tools" },
  { id: "terminal", type: "terminal", title: "Shell" },
  { id: "trajectory", type: "model-trajectory", taskId: "root" },
  {
    id: "code",
    type: "code-viewer",
    source: { type: "file", path: "/repo/file.ts", title: "file.ts" },
    sourceKey: "/repo/file.ts",
  },
  ...openSubagentSessionSidePane(null, SUBAGENT_REQUEST).tabs,
  {
    id: "bash",
    type: "bash-output",
    ...SUBAGENT_REQUEST,
    ownerTaskId: "root",
    sessionId: "parent",
    workId: "work",
  },
  { id: "chat", type: "selection-side-chat", ...SUBAGENT_REQUEST, ordinal: 1 },
  {
    id: "plan",
    type: "plan-detail",
    ...SUBAGENT_REQUEST,
    toolCallId: "plan-tool",
    markdown: "# Plan",
  },
];

describe("side-pane restore validation", () => {
  it.each([RETIRED_DIRECTORY_TAB, { id: "unknown", type: "future-tab" }])(
    "drops unsupported $type tabs while retaining supported tabs and resolving the active tab",
    (unsupported) => {
      const state = restoredState([...SUPPORTED_TABS, unsupported], unsupported.id);
      expect(normalizeWorkspaceSidePaneState(state)).toEqual({
        tabs: SUPPORTED_TABS,
        activeTabId: "plan",
      });
    },
  );

  it("drops a directory-only cached state without leaving an active pane", () => {
    const key = "directory-only-restore";
    saveTaskSidePaneMemoryState(key, {
      sidePaneState: restoredState([RETIRED_DIRECTORY_TAB], RETIRED_DIRECTORY_TAB.id),
    });
    expect(readTaskSidePaneMemoryState(key).sidePaneState).toBeNull();
  });

  it("restores a subagent-session tab from the cache after dropping an active directory tab", () => {
    const subagent = openSubagentSessionSidePane(null, SUBAGENT_REQUEST);
    const key = "subagent-session-restore";
    saveTaskSidePaneMemoryState(key, {
      sidePaneState: restoredState(
        [...subagent.tabs, RETIRED_DIRECTORY_TAB],
        RETIRED_DIRECTORY_TAB.id,
      ),
    });
    expect(readTaskSidePaneMemoryState(key).sidePaneState).toEqual(subagent);
  });

  it("preserves a supported state and the deliberately empty active selection", () => {
    const state = { tabs: SUPPORTED_TABS, activeTabId: "" };
    expect(normalizeWorkspaceSidePaneState(state)).toBe(state);
  });
});

describe("subagent-session tabs", () => {
  it("reuses the same child tab, refreshes its title, and retains its remote scope on restore", () => {
    const initial = openSubagentSessionSidePane(null, SUBAGENT_REQUEST);
    const updated = openSubagentSessionSidePane(initial, {
      ...SUBAGENT_REQUEST,
      title: "  Updated task  ",
    });
    expect(updated.tabs).toEqual([
      { ...initial.tabs[0], title: "Updated task", openedAt: expect.any(Number) },
    ]);
    expect(updated.activeTabId).toBe(initial.activeTabId);
    const tab = updated.tabs[0]!;
    expect(restoreSidePaneTab(null, tab)).toEqual(updated);
    expect(getVisibleSidePaneTabs(updated, "root")).toEqual([tab]);
    expect(getVisibleSidePaneTabs(updated, "other-root")).toEqual([]);
    expect(shouldMountSidePaneContent(false, [tab])).toBe(false);
    expect(shouldMountSidePaneContent(false, SUPPORTED_TABS)).toBe(true);
  });

  it("removes only invalidated children and selects the adjacent surviving tab", () => {
    const first = openSubagentSessionSidePane(activateGitSidePane(null), SUBAGENT_REQUEST);
    const second = openSubagentSessionSidePane(first, {
      ...SUBAGENT_REQUEST,
      childSessionId: "second-child",
    });
    const otherParent = openSubagentSessionSidePane(second, {
      ...SUBAGENT_REQUEST,
      parentSessionId: "other-parent",
      childSessionId: "other-child",
    });
    const otherRoot = openSubagentSessionSidePane(otherParent, {
      ...SUBAGENT_REQUEST,
      rootSessionId: "other-root",
      childSessionId: "other-root-child",
    });
    const synced = syncSubagentSessionSidePaneTabs(
      { ...otherRoot, activeTabId: second.activeTabId },
      { rootSessionId: "root", parentSessionId: "parent", validChildSessionIds: ["child"] },
    );
    expect(synced).toEqual({
      tabs: [first.tabs[0], first.tabs[1], otherParent.tabs[3], otherRoot.tabs[4]],
      activeTabId: first.activeTabId,
    });
  });

  it("returns null when the only child tab is invalidated", () => {
    const state = openSubagentSessionSidePane(null, SUBAGENT_REQUEST);
    expect(
      syncSubagentSessionSidePaneTabs(state, {
        rootSessionId: "root",
        parentSessionId: "parent",
        validChildSessionIds: [],
      }),
    ).toBeNull();
  });
});
