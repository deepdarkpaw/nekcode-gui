// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SESSION_IMPORT_FOCUS_INTERVAL_MS,
  useAgentSessionImport,
  type AgentSessionImportShard,
} from "./useAgentSessionImport.js";

function shardWith(...workspacePaths: string[]) {
  const importAgentSessions = vi.fn(async () => ({ inserted: 0 }));
  const shard: AgentSessionImportShard = {
    shardKey: "__base__",
    service: { importAgentSessions },
    scopes: workspacePaths.map((workspacePath) => ({ workspacePath })),
  };
  return { shard, importAgentSessions };
}

function importedPaths(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((call) => (call[0] as { workspacePath: string }).workspacePath);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useAgentSessionImport", () => {
  it("imports every sidebar project once, active project first", async () => {
    const { shard, importAgentSessions } = shardWith("/a", "/b", "/c");
    const { rerender } = renderHook(({ shards }) => useAgentSessionImport(shards, "/b"), {
      initialProps: { shards: [shard] },
    });
    await waitFor(() => expect(importAgentSessions).toHaveBeenCalledTimes(3));
    expect(importedPaths(importAgentSessions)[0]).toBe("/b");
    expect(new Set(importedPaths(importAgentSessions))).toEqual(new Set(["/a", "/b", "/c"]));

    // 同一组项目重新渲染不重复导入；新增项目只导入新的那个。
    rerender({ shards: [{ ...shard }] });
    const added = { ...shard, scopes: [...shard.scopes, { workspacePath: "/d" }] };
    rerender({ shards: [added] });
    await waitFor(() => expect(importAgentSessions).toHaveBeenCalledTimes(4));
    expect(importedPaths(importAgentSessions)[3]).toBe("/d");
  });

  it("re-imports all projects when the window returns to the foreground, throttled", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { shard, importAgentSessions } = shardWith("/a", "/b");
    renderHook(() => useAgentSessionImport([shard], "/a"));
    await waitFor(() => expect(importAgentSessions).toHaveBeenCalledTimes(2));

    // 挂载刚导入过，紧接着的 focus 不再扫一遍。
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(importAgentSessions).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + AGENT_SESSION_IMPORT_FOCUS_INTERVAL_MS);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(importAgentSessions).toHaveBeenCalledTimes(4));

    // 节流窗口内的再次 focus 被合并。
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(importAgentSessions).toHaveBeenCalledTimes(4);
  });

  it("keeps importing the remaining projects when one import fails", async () => {
    const importAgentSessions = vi.fn(async (scope: { workspacePath: string }) => {
      if (scope.workspacePath === "/broken") throw new Error("list failed");
      return { inserted: 1 };
    });
    const shard: AgentSessionImportShard = {
      shardKey: "__base__",
      service: { importAgentSessions },
      scopes: [{ workspacePath: "/broken" }, { workspacePath: "/a" }, { workspacePath: "/b" }],
    };
    renderHook(() => useAgentSessionImport([shard], "/broken"));
    await waitFor(() => expect(importAgentSessions).toHaveBeenCalledTimes(3));
  });
});
