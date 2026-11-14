// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IZCodeAgentService } from "@zcode/services";
import type {
  V4ConversationHistoryDirectoryResult,
  V4ConversationHistoryPageResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  createSubagentHistoryConversation,
  type SubagentHistoryConversation,
} from "./subagentHistoryConversation.js";
import { useSubagentHistoryConversation } from "./useSubagentHistoryConversation.js";
import { NEK_STATUS_TRANSCRIPT_REFRESH_MS } from "./types.js";
import {
  childDirectory,
  childPage,
  childPreview,
  childRow,
  childService,
  deferred,
  scope,
  settleChild,
} from "./subagentHistory.testFixtures.js";
import type { SubagentConversation } from "./useSubagentConversation.js";
import type { SubagentHistoryService } from "./subagentHistoryTypes.js";

const owners: SubagentHistoryConversation[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.close();
  vi.useRealTimers();
});
async function setup() {
  const fake = childService(childPreview("running"));
  const owner = createSubagentHistoryConversation(fake.service, scope);
  owners.push(owner);
  await settleChild();
  return { ...fake, owner };
}

it("CH3: polling changes latest rows/status only in latest reading mode and stops at terminal", async () => {
  const { owner, service } = await setup();
  const latest = childPage();
  latest.rows[0] = childRow(50, "new live text");
  service.getSubagentConversation.mockResolvedValueOnce(childPreview("completed", latest));
  await vi.advanceTimersByTimeAsync(NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  expect(owner.getState().data?.rows[0]).toMatchObject({ text: "new live text" });
  expect(owner.getState().data?.status).toBe("completed");
  await vi.advanceTimersByTimeAsync(10 * NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  expect(service.getSubagentConversation).toHaveBeenCalledTimes(2);
});

it("CH3: polling a live child preserves older viewport rows and offers explicit forward refresh", async () => {
  const { owner, service } = await setup();
  service.conversationHistoryPageV4.mockResolvedValueOnce(childPage(30, 50));
  await owner.loadOlder();
  const rows = owner.getState().data!.rows;
  service.getSubagentConversation.mockResolvedValueOnce(
    childPreview("running", childPage(60, 80, 80)),
  );
  await vi.advanceTimersByTimeAsync(NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  expect(owner.getState().data!.rows).toBe(rows);
  expect(owner.getState().historyControls!.history.hasNewer).toBe(true);
  expect(owner.getState().data!.history.totalTurns).toBe(80);
  service.conversationHistoryPageV4.mockResolvedValueOnce(childPage(60, 80, 80));
  await owner.loadNewer();
  expect(service.conversationHistoryPageV4).toHaveBeenLastCalledWith({
    workspacePath: scope.workspacePath,
    workspaceIdentity: scope.workspaceIdentity,
    remoteSessionId: scope.remoteSessionId,
    sessionId: scope.parentSessionId,
    subagentId: scope.childSessionId,
    turnLimit: 20,
    aroundEntryId: "entry:69",
  });
  service.getSubagentConversation.mockResolvedValueOnce(
    childPreview("completed", childPage(60, 80, 80)),
  );
  await vi.advanceTimersByTimeAsync(NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  expect(owner.getState().data!.rows).toHaveLength(20);
  expect(owner.getState().data?.status).toBe("completed");
});

it("CH2/CH3: polling and explicit navigation share one body flight", async () => {
  const { owner, service } = await setup();
  const pending = deferred<V4ConversationHistoryPageResult>();
  service.conversationHistoryPageV4.mockImplementationOnce(() => pending.promise);
  const request = owner.loadOlder();
  await vi.advanceTimersByTimeAsync(10 * NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  expect(service.getSubagentConversation).toHaveBeenCalledTimes(1);
  pending.resolve(childPage(30, 50));
  await request;
  const rows = owner.getState().data!.rows;
  service.getSubagentConversation.mockResolvedValueOnce(childPreview("completed"));
  await vi.advanceTimersByTimeAsync(NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  expect(owner.getState().data!.rows).toBe(rows);
  expect(owner.getState().data?.status).toBe("completed");
});

it("CH5: inactive/close cancels timer, retires pending body and metadata, and removes runtime observer", async () => {
  const { owner, service, listenerCount } = await setup();
  const pending = deferred<V4ConversationHistoryPageResult>();
  service.conversationHistoryPageV4.mockImplementationOnce(() => pending.promise);
  const request = owner.loadOlder();
  const before = owner.getState().data;
  owner.setActive(false);
  owner.setQuery("inactive-query");
  const calls = service.conversationHistoryDirectoryV4.mock.calls.length;
  pending.resolve(childPage(30, 50));
  await request;
  await vi.advanceTimersByTimeAsync(10 * NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  expect(owner.getState().data).toBe(before);
  expect(service.getSubagentConversation).toHaveBeenCalledTimes(1);
  expect(service.conversationHistoryDirectoryV4).toHaveBeenCalledTimes(calls);
  owner.setActive(true);
  await settleChild();
  const metadata = deferred<V4ConversationHistoryDirectoryResult>();
  service.conversationHistoryDirectoryV4.mockImplementationOnce(() => metadata.promise);
  owner.setQuery("late");
  owner.close();
  const state = owner.getState();
  metadata.reject(new Error("late metadata"));
  await settleChild();
  expect(owner.getState()).toBe(state);
  expect(listenerCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("CH5: hook fences old child/service/root/remote identity, and active=false never starts a read", async () => {
  const first = childService(childPreview("running"));
  const pending = deferred<SubagentConversation>();
  first.service.getSubagentConversation.mockImplementationOnce(() => pending.promise);
  const second = childService(childPreview("completed"));
  const firstService = first.service as unknown as IZCodeAgentService;
  const secondService = second.service as unknown as IZCodeAgentService;
  const { result, rerender, unmount } = renderHook(
    (props) => useSubagentHistoryConversation(props),
    {
      initialProps: { service: firstService, scope, active: false },
    },
  );
  expect(first.service.getSubagentConversation).not.toHaveBeenCalled();
  rerender({ service: firstService, scope, active: true });
  await act(async () => {
    await settleChild();
  });
  expect(first.service.getSubagentConversation).toHaveBeenCalledTimes(1);
  rerender({
    service: secondService,
    scope: {
      ...scope,
      rootSessionId: "next-root",
      remoteSessionId: "next-remote",
      childSessionId: "next-child",
    },
    active: true,
  });
  await act(async () => {
    await settleChild();
  });
  const current = result.current.data;
  await act(async () => {
    pending.resolve(childPreview("running", childPage(0, 20)));
    await settleChild();
  });
  expect(result.current.data).toBe(current);
  expect(current?.rows[0]?.turnId).toBe("turn:50");
  expect(second.service.getSubagentConversation).toHaveBeenLastCalledWith({
    workspacePath: scope.workspacePath,
    workspaceIdentity: scope.workspaceIdentity,
    remoteSessionId: "next-remote",
    sessionId: scope.parentSessionId,
    id: "next-child",
    turnLimit: 20,
  });
  unmount();
  expect(first.listenerCount()).toBe(0);
  expect(second.listenerCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("CH5: real runtime lifecycle is workspace-scoped, passive, and disposed exactly once", async () => {
  const fake = childService(childPreview("running"));
  let emit!: Parameters<NonNullable<SubagentHistoryService["onAgentRuntimeLifecycle"]>>[0];
  const dispose = vi.fn();
  const onAgentRuntimeLifecycle = vi.fn((listener: typeof emit) => {
    emit = listener;
    return { dispose };
  });
  const owner = createSubagentHistoryConversation(
    { ...fake.service, onAgentRuntimeLifecycle },
    scope,
  );
  owners.push(owner);
  await settleChild();
  const event = {
    workspacePath: scope.workspacePath,
    workspaceKey: "ssh:trusted",
    runtimeIdentity: { workspaceKey: "ssh:trusted", generation: 2, identity: "runtime:2" },
  };
  emit({ ...event, workspaceKey: "other", state: "unavailable" });
  expect(owner.getState().error).toBeNull();
  emit({ ...event, state: "unavailable" });
  emit({ ...event, state: "available" });
  await vi.advanceTimersByTimeAsync(10 * NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  expect(owner.getState().error).toContain("runtime changed");
  expect(fake.service.getSubagentConversation).toHaveBeenCalledTimes(1);
  expect(fake.service.onAgentRuntimeRestarted).not.toHaveBeenCalled();
  owner.close();
  owner.close();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("CH5: same-scope refocus preserves older reading data instead of resetting to latest", async () => {
  const { owner, service } = await setup();
  await owner.loadOlder();
  const rows = owner.getState().data!.rows;
  owner.setActive(false);
  service.getSubagentConversation.mockResolvedValueOnce(
    childPreview("completed", childPage(60, 80, 80)),
  );
  owner.setActive(true);
  await settleChild();
  expect(owner.getState().data!.rows).toBe(rows);
  expect(owner.getState().data?.status).toBe("completed");
});

it("CH6: poll failure keeps rows, stops automatic retry, and explicit retry repeats poll only", async () => {
  const { owner, service } = await setup();
  const before = owner.getState().data;
  service.getSubagentConversation.mockRejectedValueOnce(new Error("poll failed"));
  await vi.advanceTimersByTimeAsync(NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  expect(owner.getState().data).toBe(before);
  expect(owner.getState().error).toBe("poll failed");
  await vi.advanceTimersByTimeAsync(10 * NEK_STATUS_TRANSCRIPT_REFRESH_MS);
  expect(service.getSubagentConversation).toHaveBeenCalledTimes(2);
  service.getSubagentConversation.mockResolvedValueOnce(childPreview("completed"));
  await owner.retry();
  expect(service.getSubagentConversation).toHaveBeenCalledTimes(3);
  expect(service.conversationHistoryPageV4).not.toHaveBeenCalled();
  expect(owner.getState().error).toBeNull();
});

it("CH5: a fresh epoch fences late metadata/content failures, not only body responses", async () => {
  const { owner, service } = await setup();
  service.conversationHistoryPageV4.mockResolvedValueOnce(childPage(30, 50));
  await owner.loadOlder();
  await settleChild();
  const metadata = deferred<V4ConversationHistoryDirectoryResult>();
  service.conversationHistoryDirectoryV4.mockImplementationOnce(() => metadata.promise);
  owner.setQuery("late");
  const content = deferred<Awaited<ReturnType<typeof service.conversationHistoryContentV4>>>();
  service.conversationHistoryContentV4.mockImplementationOnce(() => content.promise);
  const request = owner.readContent({ ref: "ref", limit: 1 });
  const assertion = expect(request).rejects.toThrow("owner changed");
  service.conversationHistoryPageV4.mockResolvedValueOnce({ ...childPage(), atLogEpoch: "fresh" });
  service.conversationHistoryDirectoryV4.mockResolvedValueOnce({
    ...childDirectory(100),
    atLogEpoch: "fresh",
  });
  await owner.loadLatest();
  await settleChild();
  metadata.reject(new Error("late metadata failed"));
  content.resolve({
    atSeq: 1,
    atRevision: 1,
    atLogEpoch: "epoch",
    ref: "ref",
    data: "YQ==",
    offset: 0,
    totalBytes: 1,
    encoding: "base64",
    mediaType: "application/json",
  });
  await assertion;
  await settleChild();
  expect(owner.getState().error).toBeNull();
  expect(owner.getState().historyControls?.directory.items[0]?.position).toBe(100);
});

it("CH5: late closed content read rejects without publishing error or retaining its bytes", async () => {
  const { owner, service } = await setup();
  const content = deferred<Awaited<ReturnType<typeof service.conversationHistoryContentV4>>>();
  service.conversationHistoryContentV4.mockImplementationOnce(() => content.promise);
  const request = owner.readContent({ ref: "ref", offset: 3, limit: 10 });
  const assertion = expect(request).rejects.toThrow("no longer active");
  owner.close();
  const before = owner.getState();
  content.resolve({
    atSeq: 1,
    atRevision: 1,
    atLogEpoch: "epoch",
    ref: "ref",
    data: "YWJj",
    offset: 3,
    totalBytes: 6,
    encoding: "base64",
    mediaType: "application/json",
  });
  await assertion;
  expect(owner.getState()).toBe(before);
});
