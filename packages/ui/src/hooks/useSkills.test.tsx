// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSkills } from "./useSkills.js";
import type { ZCodeSkillReferenceCatalogEntry } from "@zcode/shared";

const state = vi.hoisted(() => {
  const getSkillReferenceCatalog = vi.fn();
  return {
    getSkillReferenceCatalog,
    resolution: {
      rpcReady: true,
      remoteSessionId: "remote-a",
      services: {
        zcodeAgentService: {
          getSkillReferenceCatalog,
          onAgentRuntimeRestarted: () => ({ dispose() {} }),
        },
      },
    },
  };
});
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: () => state.resolution,
}));
const skill = (name: string): ZCodeSkillReferenceCatalogEntry => ({
  id: `nek:${name}`,
  name,
  description: "",
  path: `/skills/${name}/SKILL.md`,
  scope: "user",
  enabled: true,
});
function deferred() {
  let resolve!: (value: {
    authority: "session";
    skills: ZCodeSkillReferenceCatalogEntry[];
  }) => void;
  const promise = new Promise<{ authority: "session"; skills: ZCodeSkillReferenceCatalogEntry[] }>(
    (done) => {
      resolve = done;
    },
  );
  return { promise, resolve };
}
beforeEach(() => {
  state.getSkillReferenceCatalog.mockReset();
  state.resolution.remoteSessionId = "remote-a";
});
afterEach(cleanup);

describe("nek skill catalog scope", () => {
  it("SC5: a late old-session response cannot replace the new session's skills", async () => {
    const old = deferred();
    state.getSkillReferenceCatalog
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ authority: "session", skills: [skill("pdf")] });
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useSkills({
          workspacePath: "/work",
          workspaceIdentity: "ssh://host/work",
          sessionId,
          enabled: true,
        }),
      { initialProps: { sessionId: "old" } },
    );
    rerender({ sessionId: "new" });
    await waitFor(() => expect(result.current.skills.map((item) => item.name)).toEqual(["pdf"]));
    await act(async () => old.resolve({ authority: "session", skills: [skill("stale")] }));
    expect(result.current.skills.map((item) => item.name)).toEqual(["pdf"]);
    expect(state.getSkillReferenceCatalog).toHaveBeenLastCalledWith({
      workspacePath: "/work",
      workspaceIdentity: "ssh://host/work",
      remoteSessionId: "remote-a",
      sessionId: "new",
    });
  });

  it("SC5: reconnect attachment identity fences the same logical session's old response", async () => {
    const old = deferred();
    state.getSkillReferenceCatalog
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce({ authority: "session", skills: [skill("galanalyzer")] });
    const { result, rerender } = renderHook(() =>
      useSkills({
        workspacePath: "/work",
        workspaceIdentity: "ssh://host/work",
        sessionId: "same",
        enabled: true,
      }),
    );
    state.resolution.remoteSessionId = "remote-b";
    rerender();
    await waitFor(() => expect(result.current.skills[0]?.name).toBe("galanalyzer"));
    await act(async () => old.resolve({ authority: "session", skills: [skill("stale")] }));
    expect(result.current.skills[0]?.name).toBe("galanalyzer");
    expect(state.getSkillReferenceCatalog).toHaveBeenLastCalledWith({
      workspacePath: "/work",
      workspaceIdentity: "ssh://host/work",
      remoteSessionId: "remote-b",
      sessionId: "same",
    });
  });
});
