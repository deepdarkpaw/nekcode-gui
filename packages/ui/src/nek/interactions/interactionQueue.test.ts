import { describe, expect, it } from "vitest";
import type { NekExtensionUiDialogRequest } from "@zcode/shared/nek-protocol";
import {
  EMPTY_INTERACTION_QUEUE,
  INTERACTION_QUEUE_LIMIT,
  reduceInteractionQueue,
} from "./interactionQueue.js";

function request(id: string): NekExtensionUiDialogRequest {
  return { type: "extension_ui_request", id, method: "input", title: id };
}

describe("interaction queue reducer", () => {
  it("MQ-1: drops the oldest request and queues a cancellation response", () => {
    let state = EMPTY_INTERACTION_QUEUE;
    for (let index = 0; index < INTERACTION_QUEUE_LIMIT; index += 1) {
      state = reduceInteractionQueue(state, {
        type: "enqueue",
        record: { request: request(`id-${index}`), receivedAt: index },
      });
    }
    state = reduceInteractionQueue(state, {
      type: "enqueue",
      record: { request: request("new"), receivedAt: 99 },
    });
    expect(state.queue[0]?.request.id).toBe("id-1");
    expect(state.queue).toHaveLength(INTERACTION_QUEUE_LIMIT);
    expect(state.outbox).toEqual([
      {
        requestId: "id-0",
        response: { type: "extension_ui_response", id: "id-0", cancelled: true },
      },
    ]);
  });

  it("MQ-2/MQ-4: keeps FIFO order and removes only the requested record", () => {
    let state = reduceInteractionQueue(EMPTY_INTERACTION_QUEUE, {
      type: "enqueue",
      record: { request: request("first"), receivedAt: 1 },
    });
    state = reduceInteractionQueue(state, {
      type: "enqueue",
      record: { request: request("second"), receivedAt: 2 },
    });
    state = reduceInteractionQueue(state, { type: "remove", requestId: "first", reason: "user" });
    expect(state.queue.map((record) => record.request.id)).toEqual(["second"]);
  });

  it("MQ-3: host cancellation removes a middle request without answering", () => {
    let state = EMPTY_INTERACTION_QUEUE;
    for (const id of ["first", "middle", "last"]) {
      state = reduceInteractionQueue(state, {
        type: "enqueue",
        record: { request: request(id), receivedAt: 1 },
      });
    }
    state = reduceInteractionQueue(state, { type: "remove", requestId: "middle", reason: "host" });
    expect(state.queue.map((record) => record.request.id)).toEqual(["first", "last"]);
    expect(state.outbox).toHaveLength(0);
  });

  it("MQ-5/MQ-6: preserves drafts until close and clears them on disconnect", () => {
    let state = reduceInteractionQueue(EMPTY_INTERACTION_QUEUE, {
      type: "enqueue",
      record: { request: request("draft"), receivedAt: 1 },
    });
    state = reduceInteractionQueue(state, {
      type: "setDraft",
      requestId: "draft",
      draft: { text: "x" },
    });
    expect(state.drafts.draft).toEqual({ text: "x" });
    state = reduceInteractionQueue(state, { type: "disconnect" });
    expect(state.queue).toHaveLength(0);
    expect(state.drafts).toEqual({});
  });

  it("MQ-3/00-common-5.2: host cancellation records a notice when a draft exists", () => {
    let state = reduceInteractionQueue(EMPTY_INTERACTION_QUEUE, {
      type: "enqueue",
      record: { request: request("host"), receivedAt: 1 },
    });
    state = reduceInteractionQueue(state, { type: "setDraft", requestId: "host", draft: "draft" });
    state = reduceInteractionQueue(state, { type: "remove", requestId: "host", reason: "host" });
    expect(state.notices).toEqual([{ requestId: "host", id: "nek.interaction.cancelledByHost" }]);
  });
});
