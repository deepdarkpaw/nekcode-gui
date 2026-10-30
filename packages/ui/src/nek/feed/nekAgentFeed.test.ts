import { Emitter } from "@zcode/rpc";
import type { IZCodeAgentService } from "@zcode/services";
import type {
  NekExtensionUiDialogRequest,
  NekInteractionFrame,
} from "@zcode/shared/nek-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  acquireNekAgentFeed,
  createNekSubagentControllerFeed,
  type NekAgentFeedService,
} from "./nekAgentFeed.js";
import { createNekInteractionStore } from "@/nek/interactions/interactionStore.js";

const target = { workspacePath: "/workspace", workspaceIdentity: "local-workspace" };

function request(id: string): NekExtensionUiDialogRequest {
  return { type: "extension_ui_request", id, method: "input", title: id };
}

function fakeService() {
  const emitter = new Emitter<NekInteractionFrame>();
  const response = vi.fn(async () => undefined);
  const service = {
    onDynamicNekInteractionFrame: vi.fn(() => emitter.event),
    respondNekInteraction: response,
    stopSubagent: vi.fn(async () => ({ status: "aborted" as const })),
    getSubagentTranscript: vi.fn(async () => ({ messages: ["message"] })),
    listAgentTypes: vi.fn(async () => ({ types: [] })),
  } satisfies NekAgentFeedService;
  return { emitter, response, service };
}

function store() {
  return createNekInteractionStore({
    respond: vi.fn(),
    onEffect: vi.fn(),
  });
}

describe("nek agent feed", () => {
  it("writes request frames, removes cancel frames, and clears on release", () => {
    const { emitter, service } = fakeService();
    const interactionStore = store();
    const lease = acquireNekAgentFeed(service, target, interactionStore);
    emitter.fire({ kind: "request", scope: target, request: request("request-1") });
    expect(interactionStore.getState().getHead("/workspace")?.request.id).toBe("request-1");

    emitter.fire({ kind: "cancel", scope: target, id: "request-1" });
    expect(interactionStore.getState().getHead("/workspace")).toBeUndefined();

    emitter.fire({
      kind: "request",
      scope: { ...target, sessionId: "session-1" },
      request: request("request-2"),
    });
    expect(interactionStore.getState().getHead("session-1")?.request.id).toBe("request-2");
    lease.release();
    expect(interactionStore.getState().sessions).toEqual({});
    expect(service.onDynamicNekInteractionFrame).toHaveBeenCalledOnce();
  });

  it("responds through the RPC and keeps a failed request retryable", async () => {
    const { emitter, response, service } = fakeService();
    const interactionStore = store();
    const lease = acquireNekAgentFeed(service, target, interactionStore);
    emitter.fire({ kind: "request", scope: target, request: request("request-1") });
    const answer = { type: "extension_ui_response" as const, id: "request-1", value: "ok" };

    await expect(
      interactionStore
        .getState()
        .settleAsync("/workspace", "request-1", answer, (_session, response) =>
          lease.feed.respond({ requestId: response.id, response }),
        ),
    ).resolves.toBe(true);
    expect(response).toHaveBeenCalledWith({ requestId: "request-1", response: answer });
    expect(interactionStore.getState().getHead("/workspace")).toBeUndefined();

    emitter.fire({ kind: "request", scope: target, request: request("request-2") });
    response.mockRejectedValueOnce(new Error("transport down"));
    await expect(
      interactionStore
        .getState()
        .settleAsync(
          "/workspace",
          "request-2",
          { type: "extension_ui_response", id: "request-2", value: "retry" },
          (_session, response) => lease.feed.respond({ requestId: response.id, response }),
        ),
    ).rejects.toThrow("transport down");
    expect(interactionStore.getState().getHead("/workspace")?.request.id).toBe("request-2");

    lease.release();
  });

  it("removes a request when the backend reports an unknown id", async () => {
    const { emitter, service } = fakeService();
    const interactionStore = store();
    const lease = acquireNekAgentFeed(service, target, interactionStore);
    emitter.fire({ kind: "request", scope: target, request: request("gone") });
    service.respondNekInteraction = vi.fn(async () => {
      throw new Error("nek interaction gone is no longer pending");
    });

    await expect(
      lease.feed.respond({
        requestId: "gone",
        response: { type: "extension_ui_response", id: "gone", cancelled: true },
      }),
    ).rejects.toThrow("Interaction gone is no longer pending");
    expect(interactionStore.getState().getHead("/workspace")).toBeUndefined();
    lease.release();
  });

  it("routes the three subagent RPCs through the same service feed", async () => {
    const { service } = fakeService();
    const lease = acquireNekAgentFeed(service, target);
    const sessionTarget = { ...target, sessionId: "session-1" } as Parameters<
      IZCodeAgentService["listAgentTypes"]
    >[0];
    const controllerFeed = createNekSubagentControllerFeed(
      lease.feed,
      target,
      sessionTarget.sessionId,
    );
    await controllerFeed.onStop("child-1");
    await controllerFeed.fetchTranscript("child-1");
    await controllerFeed.listAgentTypes();
    expect(service.stopSubagent).toHaveBeenCalledWith({ ...sessionTarget, id: "child-1" });
    expect(service.getSubagentTranscript).toHaveBeenCalledWith({ ...sessionTarget, id: "child-1" });
    expect(service.listAgentTypes).toHaveBeenCalledWith(sessionTarget);
    lease.release();
  });
});
