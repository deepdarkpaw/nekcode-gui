/**
 * 运行中发送：与 CLI 一致，Enter（缺省 / guide）走 `steer`，`queue` 走 `follow_up`，
 * `startNow` 先 `abort` 再 `prompt`。此前缺省投递在运行中直接抛
 * "streamingBehavior is required while nek is running"，GUI 弹出发送失败。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { command, harness, params, target } from "./nekSessionHarness.js";

function send(
  h: ReturnType<typeof harness>,
  commandId: string,
  requestedDelivery?: "startNow" | "queue" | "guide",
) {
  return h.adapter.sendNekConversationCommandV4({
    target,
    envelope: {
      ...command,
      commandId,
      payload: { text: commandId, ...(requestedDelivery ? { requestedDelivery } : {}) },
    },
  });
}

function sentTypes(h: ReturnType<typeof harness>): string[] {
  const relevant = new Set(["prompt", "steer", "follow_up", "abort"]);
  return (h.sessions[0]?.commands ?? [])
    .map((item) => item.type)
    .filter((type) => relevant.has(type));
}

test("sending while nek is running queues like the CLI instead of failing", async () => {
  const h = harness();
  try {
    await h.adapter.subscribeConversationV4(params);
    const first = await send(h, "first");
    assert.equal(first.status, "accepted");

    const enter = await send(h, "enter");
    assert.equal(enter.status, "accepted");
    assert.equal(
      enter.status === "accepted" && enter.result?.type === "inputAccepted"
        ? enter.result.delivery
        : undefined,
      "guide",
    );

    const queued = await send(h, "queued", "queue");
    assert.equal(
      queued.status === "accepted" && queued.result?.type === "inputAccepted"
        ? queued.result.delivery
        : undefined,
      "queue",
    );

    await send(h, "now", "startNow");
    assert.deepEqual(sentTypes(h), ["prompt", "steer", "follow_up", "abort", "prompt"]);
  } finally {
    await h.adapter.dispose();
  }
});
