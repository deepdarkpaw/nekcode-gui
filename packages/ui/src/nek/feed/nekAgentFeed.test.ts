import { Emitter } from "@zcode/rpc";
import type { IZCodeAgentService } from "@zcode/services";
import type {
  NekExtensionUiDialogRequest,
  NekExtensionUiResponse,
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

function request(id: string, timeout?: number): NekExtensionUiDialogRequest {
  return {
    type: "extension_ui_request",
    id,
    method: "input",
    title: id,
    ...(timeout === undefined ? {} : { timeout }),
  };
}

function answer(id: string, value = "ok"): NekExtensionUiResponse {
  return { type: "extension_ui_response", id, value };
}

function fakeService() {
  const emitter = new Emitter<NekInteractionFrame>();
  const response = vi.fn(async (_params: unknown) => undefined);
  const dispose = vi.fn();
  const service = {
    onDynamicNekInteractionFrame: vi.fn(() => (listener: (frame: NekInteractionFrame) => void) => {
      const subscription = emitter.event(listener);
      return {
        dispose: () => {
          dispose();
          subscription.dispose();
        },
      };
    }),
    respondNekInteraction: response,
    stopSubagent: vi.fn(async () => ({ status: "aborted" as const })),
    getSubagentTranscript: vi.fn(async () => ({ messages: ["message"] })),
    listAgentTypes: vi.fn(async () => ({ types: [] })),
  } satisfies NekAgentFeedService;
  return { emitter, response, service, dispose };
}

interface StoreOptions {
  now?: () => number;
  onTick?: (callback: () => void) => void;
}

function store(options: StoreOptions = {}) {
  return createNekInteractionStore({
    respond: vi.fn(),
    onEffect: vi.fn(),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onTick
      ? {
          setIntervalFn: (callback: () => void) => {
            options.onTick?.(callback);
            return callback;
          },
          clearIntervalFn: () => undefined,
        }
      : {}),
  });
}

describe("nek agent feed", () => {
  it("writes request frames, removes cancel frames, and clears on release", () => {
    const { emitter, service, dispose } = fakeService();
    const interactionStore = store();
    const lease = acquireNekAgentFeed(service, target, interactionStore);
    expect(service.onDynamicNekInteractionFrame).toHaveBeenCalledWith(target);
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
    // 会话随后被回收时，取消帧仍要能按 id 命中。
    emitter.fire({ kind: "cancel", scope: target, id: "request-2" });
    expect(interactionStore.getState().getHead("session-1")).toBeUndefined();

    lease.release();
    expect(interactionStore.getState().sessions).toEqual({});
    expect(service.onDynamicNekInteractionFrame).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("shares one subscription between panes and only tears down on the last release", () => {
    const { emitter, service, dispose } = fakeService();
    const interactionStore = store();
    const first = acquireNekAgentFeed(service, target, interactionStore);
    const second = acquireNekAgentFeed(service, { ...target }, interactionStore);
    expect(first.feed).toBe(second.feed);
    expect(service.onDynamicNekInteractionFrame).toHaveBeenCalledOnce();

    emitter.fire({ kind: "request", scope: target, request: request("request-1") });
    first.release();
    expect(dispose).not.toHaveBeenCalled();
    expect(interactionStore.getState().getHead("/workspace")?.request.id).toBe("request-1");

    second.release();
    expect(dispose).toHaveBeenCalledOnce();
    expect(interactionStore.getState().sessions).toEqual({});
    second.release();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("responds through the RPC and keeps a failed request retryable", async () => {
    const { emitter, response, service } = fakeService();
    const interactionStore = store();
    const lease = acquireNekAgentFeed(service, target, interactionStore);
    emitter.fire({ kind: "request", scope: target, request: request("request-1") });

    await expect(
      interactionStore
        .getState()
        .settleAsync("/workspace", "request-1", answer("request-1"), (_session, next) =>
          lease.feed.respond({ requestId: next.id, response: next }),
        ),
    ).resolves.toBe(true);
    expect(response).toHaveBeenCalledWith({
      requestId: "request-1",
      response: answer("request-1"),
    });
    expect(interactionStore.getState().getHead("/workspace")).toBeUndefined();

    emitter.fire({ kind: "request", scope: target, request: request("request-2") });
    response.mockRejectedValueOnce(new Error("transport down"));
    await expect(
      interactionStore
        .getState()
        .settleAsync("/workspace", "request-2", answer("request-2", "retry"), (_session, next) =>
          lease.feed.respond({ requestId: next.id, response: next }),
        ),
    ).rejects.toThrow("transport down");
    expect(interactionStore.getState().getHead("/workspace")?.request.id).toBe("request-2");

    // 用同一个回答重试：第二次成功后才关闭卡片。
    await expect(
      interactionStore
        .getState()
        .settleAsync("/workspace", "request-2", answer("request-2", "retry"), (_session, next) =>
          lease.feed.respond({ requestId: next.id, response: next }),
        ),
    ).resolves.toBe(true);
    expect(interactionStore.getState().getHead("/workspace")).toBeUndefined();
    lease.release();
  });

  it("removes a request and leaves a notice when the backend reports an unknown id", async () => {
    const { emitter, service } = fakeService();
    const interactionStore = store();
    const lease = acquireNekAgentFeed(service, target, interactionStore);
    emitter.fire({ kind: "request", scope: target, request: request("gone") });
    service.respondNekInteraction = vi.fn(async () => {
      throw new Error("nek interaction gone is no longer pending");
    });

    await expect(
      lease.feed.respond({ requestId: "gone", response: answer("gone", "late") }),
    ).rejects.toThrow("Interaction gone is no longer pending");
    expect(interactionStore.getState().getHead("/workspace")).toBeUndefined();
    expect(interactionStore.getState().takeNotices("/workspace")).toEqual([
      { requestId: "gone", id: "nek.interaction.cancelledByHost" },
    ]);
    lease.release();
  });

  it("delivers a GUI-side timeout cancel through respondNekInteraction", () => {
    const { emitter, response, service } = fakeService();
    let tick: (() => void) | undefined;
    let now = 0;
    const interactionStore = store({
      now: () => now,
      onTick: (callback) => {
        tick = callback;
      },
    });
    const lease = acquireNekAgentFeed(service, target, interactionStore);
    emitter.fire({ kind: "request", scope: target, request: request("slow", 1_000) });

    // store 的兜底 responder 是 no-op；超时取消必须走 feed 注册的通道才回得到后端。
    now = 1_500;
    tick?.();
    expect(response).toHaveBeenCalledWith({
      requestId: "slow",
      response: { type: "extension_ui_response", id: "slow", cancelled: true },
    });
    expect(interactionStore.getState().getHead("/workspace")).toBeUndefined();
    expect(interactionStore.getState().takeNotices("/workspace")).toEqual([
      { requestId: "slow", id: "nek.interaction.timedOut" },
    ]);
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
