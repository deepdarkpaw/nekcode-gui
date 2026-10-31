// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  pickWorkspaceInteractionOwner,
  resetWorkspaceInteractionOwnership,
  useWorkspaceInteractionOwnership,
  workspaceInteractionClaimCount,
  type WorkspaceInteractionClaim,
} from "./workspaceInteractionOwnership.js";

function claim(
  paneId: string,
  primary = false,
  workspaceKey = "/workspace",
): WorkspaceInteractionClaim {
  return { workspaceKey, paneId, primary };
}

afterEach(() => {
  cleanup();
  resetWorkspaceInteractionOwnership();
});

describe("workspace interaction ownership", () => {
  it("prefers the layout primary pane over any other pane of the workspace", () => {
    const panes = new Map([
      ["pane-a", false],
      ["pane-b", true],
      ["pane-c", false],
    ]);
    expect(pickWorkspaceInteractionOwner(panes)).toBe("pane-b");
  });

  it("falls back to the smallest pane id so a workspace without its primary still renders once", () => {
    expect(
      pickWorkspaceInteractionOwner(
        new Map([
          ["pane-z", false],
          ["pane-a", false],
        ]),
      ),
    ).toBe("pane-a");
    expect(pickWorkspaceInteractionOwner(new Map())).toBeUndefined();
  });

  it("only one of several panes showing the same workspace owns the card", () => {
    const primary = renderHook(() =>
      useWorkspaceInteractionOwnership(claim("workspace-main", true)),
    );
    const secondary = renderHook(() => useWorkspaceInteractionOwnership(claim("pane-2")));

    expect(primary.result.current).toBe(true);
    expect(secondary.result.current).toBe(false);
    expect(workspaceInteractionClaimCount()).toBe(1);
  });

  it("hands ownership over when the owning pane unmounts", () => {
    const first = renderHook(() => useWorkspaceInteractionOwnership(claim("pane-a")));
    const second = renderHook(() => useWorkspaceInteractionOwnership(claim("pane-b")));
    expect(first.result.current).toBe(true);
    expect(second.result.current).toBe(false);

    act(() => first.unmount());
    expect(second.result.current).toBe(true);
    expect(workspaceInteractionClaimCount()).toBe(1);
  });

  it("keeps workspaces independent and side panes unregistered", () => {
    const local = renderHook(() => useWorkspaceInteractionOwnership(claim("workspace-main", true)));
    const other = renderHook(() =>
      useWorkspaceInteractionOwnership(claim("workspace-main", true, "/other")),
    );
    const sidePane = renderHook(() => useWorkspaceInteractionOwnership(undefined));

    expect(local.result.current).toBe(true);
    expect(other.result.current).toBe(true);
    expect(sidePane.result.current).toBe(false);
    expect(workspaceInteractionClaimCount()).toBe(2);
  });

  it("the primary pane takes ownership as soon as it mounts", () => {
    const secondary = renderHook(() => useWorkspaceInteractionOwnership(claim("pane-2")));
    expect(secondary.result.current).toBe(true);

    const primary = renderHook(() =>
      useWorkspaceInteractionOwnership(claim("workspace-main", true)),
    );
    expect(primary.result.current).toBe(true);
    expect(secondary.result.current).toBe(false);
  });
});
