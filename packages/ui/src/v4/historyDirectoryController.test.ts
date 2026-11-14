import { describe, expect, it, vi } from "vitest";
import type {
  ConversationSnapshot,
  V4ConversationHistoryDirectoryResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationStoreState } from "./conversationProjectionStore.js";
import { createHistoryDirectoryController } from "./historyDirectoryController.js";

function result(start = 0, count = 100, hasMore = true): V4ConversationHistoryDirectoryResult {
  return {
    atSeq: 1,
    atRevision: 1,
    atLogEpoch: "epoch",
    items: Array.from({ length: count }, (_, n) => ({
      entryId: `entry:${n + start}`,
      turnId: `turn:${n + start}`,
      position: n + start,
      preview: "question",
    })),
    hasMore,
    nextCursor: hasMore ? `cursor:${start + count}` : undefined,
    totalTurns: 2000,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function source() {
  const listeners = new Set<() => void>();
  let owner = "owner:1";
  const readHistoryDirectory = vi.fn(async () => result());
  return {
    readHistoryDirectory,
    getState: () =>
      ({
        status: "live",
        snapshot: { sessionId: "parent", history: {} } as ConversationSnapshot,
        turnNavigatorDirectoryRevision: 0,
      }) as ConversationStoreState,
    getHistoryOwnerKey: () => owner,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    changeOwner() {
      owner += ":next";
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("history metadata directory", () => {
  it("RH6: one initial page, explicit single-flight loadMore and max1000 retained summaries", async () => {
    const store = source();
    const controller = createHistoryDirectoryController(store, { query: "hello", limit: 10000 });
    await settle();
    expect(store.readHistoryDirectory).toHaveBeenCalledTimes(1);
    expect(store.readHistoryDirectory).toHaveBeenCalledWith({ query: "hello", limit: 100 });
    for (let index = 1; index < 13; index++) {
      store.readHistoryDirectory.mockResolvedValueOnce(result(index * 100));
      await Promise.all([controller.loadMore(), controller.loadMore()]);
    }
    expect(store.readHistoryDirectory).toHaveBeenCalledTimes(13);
    expect(controller.getState().items).toHaveLength(1000);
    expect(controller.getState().items[0]?.position).toBe(300);
    expect(controller.getState().hasMore).toBe(true);
    controller.close();
    expect(store.listenerCount()).toBe(0);
  });

  it("RH6/RH2: late query/owner results never enter a new metadata scope", async () => {
    const store = source();
    const old = deferred<V4ConversationHistoryDirectoryResult>();
    store.readHistoryDirectory.mockImplementationOnce(() => old.promise);
    const controller = createHistoryDirectoryController(store, { query: "old" });
    store.readHistoryDirectory.mockResolvedValueOnce(result(100, 1, false));
    controller.setQuery({ query: "new", direction: "oldest" });
    await settle();
    old.resolve(result(0, 1, false));
    await settle();
    expect(controller.getState().items[0]?.position).toBe(100);
    const staleOwner = deferred<V4ConversationHistoryDirectoryResult>();
    store.readHistoryDirectory.mockImplementationOnce(() => staleOwner.promise);
    const reload = controller.reload();
    store.readHistoryDirectory.mockResolvedValueOnce(result(200, 1, false));
    store.changeOwner();
    await settle();
    staleOwner.resolve(result(10, 1, false));
    await reload;
    expect(controller.getState().items[0]?.position).toBe(200);
    controller.close();
  });

  it("RH6: oldest/around lookups and identical query do not hydrate or duplicate initial reads", async () => {
    const store = source();
    const controller = createHistoryDirectoryController(store, {
      direction: "oldest",
      aroundEntryId: "entry:1",
    });
    await settle();
    controller.setQuery({ direction: "oldest", aroundEntryId: "entry:1" });
    await settle();
    expect(store.readHistoryDirectory).toHaveBeenCalledTimes(1);
    expect(store.readHistoryDirectory).toHaveBeenCalledWith({
      direction: "oldest",
      aroundEntryId: "entry:1",
      limit: 100,
    });
    controller.close();
  });

  it("RH7: failed/nonadvancing metadata keeps items and allows explicit scoped retry", async () => {
    const store = source();
    const controller = createHistoryDirectoryController(store);
    await settle();
    const before = controller.getState().items;
    store.readHistoryDirectory.mockRejectedValueOnce(new Error("directory failed"));
    await controller.loadMore();
    expect(controller.getState()).toMatchObject({
      items: before,
      loading: false,
      error: "directory failed",
    });
    store.readHistoryDirectory.mockResolvedValueOnce(result());
    await controller.loadMore();
    expect(controller.getState().error).toContain("did not advance");
    store.readHistoryDirectory.mockResolvedValueOnce(result(100));
    await controller.loadMore();
    expect(controller.getState().error).toBeNull();
    expect(controller.getState().items).toHaveLength(200);
    controller.close();
  });

  it("RH6: close discards a pending page without publishing", async () => {
    const store = source();
    const pending = deferred<V4ConversationHistoryDirectoryResult>();
    store.readHistoryDirectory.mockImplementationOnce(() => pending.promise);
    const controller = createHistoryDirectoryController(store);
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.close();
    pending.resolve(result());
    await settle();
    expect(listener).not.toHaveBeenCalled();
  });
});
