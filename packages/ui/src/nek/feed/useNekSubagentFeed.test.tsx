// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { Emitter } from "@zcode/rpc";
import type {
  NekAgentTypeInfo,
  NekInteractionFrame,
  NekSubagentRecord,
} from "@zcode/shared/nek-protocol";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useSubagentCardController } from "@/nek/status/useSubagentCardController.js";
import { useSubagentTranscriptController } from "@/nek/status/useSubagentTranscriptController.js";
import { useNekStatusStore } from "@/nek/status/store.js";
import {
  NekAgentFeedProvider,
  type NekAgentFeedService,
  type NekAgentFeedTarget,
} from "./nekAgentFeed.js";
import { useNekSubagentFeed } from "./useNekSubagentFeed.js";

const target: NekAgentFeedTarget = {
  workspacePath: "/workspace",
  workspaceIdentity: "local-workspace",
};
const sessionTarget = { ...target, sessionId: "session-1" };

const AGENT_TYPES: NekAgentTypeInfo[] = [
  {
    name: "worker",
    description: "Worker",
    source: "builtin",
    readonly: true,
    background: true,
    autonomous: false,
  },
];

function fakeService() {
  const emitter = new Emitter<NekInteractionFrame>();
  const service: NekAgentFeedService = {
    onDynamicNekInteractionFrame: vi.fn(() => emitter.event),
    respondNekInteraction: vi.fn(async () => undefined),
    stopSubagent: vi.fn(async () => ({ status: "aborted" as const })),
    getSubagentTranscript: vi.fn(async () => ({ messages: ["line"] as unknown[] })),
    listAgentTypes: vi.fn(async () => ({ types: AGENT_TYPES })),
  };
  return { service, emitter };
}

function record(id: string): NekSubagentRecord {
  return {
    id,
    description: `description-${id}`,
    type: "worker",
    background: true,
    status: "running",
    startedAt: 0,
  };
}

function feedWrapper(service: NekAgentFeedService) {
  return function FeedWrapper({ children }: PropsWithChildren) {
    return (
      <ZCodeIntlProvider initialLocale="en-US">
        <NekAgentFeedProvider service={service} target={target}>
          {children}
        </NekAgentFeedProvider>
      </ZCodeIntlProvider>
    );
  };
}

beforeEach(() => {
  useNekStatusStore.getState().reset();
});
afterEach(() => {
  cleanup();
});

describe("useNekSubagentFeed", () => {
  it("routes stop, transcript and agent types through the workspace feed", async () => {
    const { service } = fakeService();
    const { result } = renderHook(() => useNekSubagentFeed("session-1"), {
      wrapper: feedWrapper(service),
    });

    await act(async () => {
      await result.current.onStop("child-1");
      await result.current.fetchTranscript("child-1");
    });
    await expect(result.current.listAgentTypes()).resolves.toEqual({ types: AGENT_TYPES });

    expect(service.stopSubagent).toHaveBeenCalledWith({ ...sessionTarget, id: "child-1" });
    expect(service.getSubagentTranscript).toHaveBeenCalledWith({
      ...sessionTarget,
      id: "child-1",
    });
    expect(service.listAgentTypes).toHaveBeenCalledWith(sessionTarget);
  });

  it("keeps a failed stop visible on the subagent card and retries through the same RPC", async () => {
    const { service } = fakeService();
    vi.mocked(service.stopSubagent)
      .mockRejectedValueOnce(new Error("nek rejected nek.stop_subagent"))
      .mockResolvedValueOnce({ status: "aborted" });
    useNekStatusStore.getState().consumeEvent(
      "session-1",
      {
        type: "nek.subagent",
        payload: record("child-1"),
      },
      0,
    );

    const { result } = renderHook(
      () => {
        const bindings = useNekSubagentFeed("session-1");
        const card = useSubagentCardController({
          sessionKey: "session-1",
          id: "child-1",
          onStop: bindings.onStop,
          onOpenTranscript: vi.fn(),
        });
        return { bindings, card };
      },
      { wrapper: feedWrapper(service) },
    );

    await act(async () => {
      await result.current.card.actions.stop.run();
    });
    expect(result.current.card.actions.stop.error).toContain("nek rejected nek.stop_subagent");
    expect(
      useNekStatusStore.getState().sessions["session-1"]?.subagents.byId["child-1"]?.stopRequested,
    ).toBeUndefined();

    await act(async () => {
      await result.current.card.actions.stop.run();
    });
    expect(service.stopSubagent).toHaveBeenCalledTimes(2);
    expect(
      useNekStatusStore.getState().sessions["session-1"]?.subagents.byId["child-1"]?.stopRequested,
    ).toBe(true);
  });

  it("loads a subagent transcript, surfaces the first failure and recovers on retry", async () => {
    const { service } = fakeService();
    vi.mocked(service.getSubagentTranscript)
      .mockRejectedValueOnce(new Error("nek session session-1 is not open"))
      .mockResolvedValue({ messages: ["first", "second"] });

    const { result } = renderHook(
      () => {
        const bindings = useNekSubagentFeed("session-1");
        const transcript = useSubagentTranscriptController({
          sessionKey: "session-1",
          id: "child-1",
          fetchTranscript: bindings.fetchTranscript,
          onBack: vi.fn(),
        });
        return { bindings, transcript };
      },
      { wrapper: feedWrapper(service) },
    );

    await waitFor(() =>
      expect(result.current.transcript.view.state).toEqual({
        status: "error",
        message: "nek session session-1 is not open",
      }),
    );
    expect(result.current.transcript.actions.retry.visible).toBe(true);

    await act(async () => {
      await result.current.transcript.actions.retry.run();
    });
    await waitFor(() =>
      expect(result.current.transcript.view.state).toEqual({
        status: "loaded",
        messages: ["first", "second"],
        truncatedCount: 0,
      }),
    );
    expect(service.getSubagentTranscript).toHaveBeenCalledTimes(2);
    expect(service.getSubagentTranscript).toHaveBeenCalledWith({
      ...sessionTarget,
      id: "child-1",
    });
  });
});
