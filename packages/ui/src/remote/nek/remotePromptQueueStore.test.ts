import { describe, expect, it, vi } from "vitest";
import type { RemoteHostKeyPrompt, RemotePromptRequest } from "@zcode/shared/nek-protocol";
import {
  INITIAL_REMOTE_PROMPT_QUEUE_STATE,
  REMOTE_PROMPT_QUEUE_LIMIT,
  reduceRemotePromptQueue,
  selectActiveRemotePrompt,
  selectRemotePromptQueueLength,
  useRemotePromptQueueStore,
} from "./remotePromptQueueStore.js";

function password(id: string): RemotePromptRequest {
  return { id, connectionId: "connection-a", kind: "password", username: "alice", host: "host" };
}

function hostKey(id: string): RemoteHostKeyPrompt {
  return {
    id,
    connectionId: "connection-a",
    kind: "host_key",
    host: "host",
    port: 22,
    keyType: "ssh-ed25519",
    fingerprint: `SHA256:${id}`,
  };
}

describe("remote prompt queue", () => {
  it("PQ-1: keeps a global FIFO queue capped at sixteen and cancels the oldest overflow", async () => {
    const responder = vi.fn(async () => undefined);
    const store = useRemotePromptQueueStore.getState();
    store.reset();
    store.setResponder(responder);
    for (let index = 0; index < REMOTE_PROMPT_QUEUE_LIMIT + 1; index += 1) {
      store.enqueuePrompt(password(`prompt-${index}`));
    }
    expect(useRemotePromptQueueStore.getState().items).toHaveLength(REMOTE_PROMPT_QUEUE_LIMIT);
    expect(useRemotePromptQueueStore.getState().items[0]?.id).toBe("prompt-1");
    expect(responder).toHaveBeenCalledWith("prompt-0", { cancelled: true });
    store.reset();
  });

  it("PQ-2: exposes only the first item as active and counts the remainder", () => {
    let state = INITIAL_REMOTE_PROMPT_QUEUE_STATE;
    state = reduceRemotePromptQueue(state, { type: "enqueue", item: password("one") });
    state = reduceRemotePromptQueue(state, { type: "enqueue", item: password("two") });
    expect(selectActiveRemotePrompt(state)?.id).toBe("one");
    expect(selectRemotePromptQueueLength(state)).toBe(1);
  });

  it("PQ-3: cancels the head with a reason notice but removes middle items silently", () => {
    let state = INITIAL_REMOTE_PROMPT_QUEUE_STATE;
    state = reduceRemotePromptQueue(state, { type: "enqueue", item: password("one") });
    state = reduceRemotePromptQueue(state, { type: "enqueue", item: password("two") });
    const middle = reduceRemotePromptQueue(state, {
      type: "cancel",
      id: "two",
      reason: "superseded",
    });
    expect(middle.items.map((item) => item.id)).toEqual(["one"]);
    expect(middle.notice).toBeNull();
    const head = reduceRemotePromptQueue(middle, {
      type: "cancel",
      id: "one",
      reason: "timeout",
    });
    expect(head.items).toEqual([]);
    expect(head.notice).toEqual({ id: "remote.nek.prompt.timeout" });
  });

  it("PQ-3: maps aborted, disconnected, and superseded notices exactly", () => {
    const reasons = ["aborted", "disconnected", "superseded"] as const;
    const notices = ["remote.nek.prompt.aborted", "remote.nek.prompt.disconnected", null] as const;
    for (const [index, reason] of reasons.entries()) {
      const state = reduceRemotePromptQueue(
        { items: [password("one")], notice: null },
        { type: "cancel", id: "one", reason },
      );
      expect(state.notice?.id ?? null).toBe(notices[index]);
    }
  });

  it("PQ-4: queues host-key-changed notifications without an answer", async () => {
    const store = useRemotePromptQueueStore.getState();
    store.reset();
    store.handleEvent({
      id: "changed-1",
      connectionId: "connection-a",
      kind: "host_key_changed",
      host: "host",
      port: 22,
      keyType: "ssh-ed25519",
      oldFingerprint: "SHA256:old",
      newFingerprint: "SHA256:new",
    });
    expect(selectActiveRemotePrompt(useRemotePromptQueueStore.getState())?.kind).toBe(
      "host_key_changed",
    );
    await expect(store.respond("changed-1", { cancelled: true })).resolves.toBeUndefined();
    store.reset();
  });

  it("PQ-5: preserves arrival order when the head is removed", () => {
    const store = useRemotePromptQueueStore.getState();
    store.reset();
    store.enqueuePrompt(hostKey("host-1"));
    store.enqueuePrompt(password("password-1"));
    store.removePrompt("host-1");
    expect(selectActiveRemotePrompt(useRemotePromptQueueStore.getState())?.id).toBe("password-1");
    store.reset();
  });

  it("PQ-1: invalid duplicate enqueue returns the same pure state reference", () => {
    const state = { items: [password("one")], notice: null };
    expect(reduceRemotePromptQueue(state, { type: "enqueue", item: password("one") })).toBe(state);
  });
});
