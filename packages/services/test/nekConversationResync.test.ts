import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationTopicWireCandidate } from "@zcode/shared/zcode-protocol-v4";
import { harness, params, target } from "./nekSessionHarness.js";

function ordinalsOf(frames: readonly ConversationTopicWireCandidate[]): number[] {
  return frames.flatMap((frame) => (frame.kind === "complete" ? [frame.logicalFrameOrdinal] : []));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// 客户端丢弃序号不大于已处理最大值的帧：恢复帧若沿用订阅建立时的旧序号，会在有实时帧之后
// 被静默丢弃，界面只能等到 recoveryFrameTimedOut（打包验收第 10 步曾因此失败）。
test("a resync after live frames emits a recovery frame newer than every live frame", async () => {
  const h = harness();
  const frames: ConversationTopicWireCandidate[] = [];
  h.adapter.onDynamicConversationFrame(target)((frame) => frames.push(frame));
  try {
    const subscription = await h.adapter.subscribeConversationV4(params);
    const session = h.sessions[0];
    assert.ok(session, "subscribing restores the disk session");
    session.emit({
      type: "message_start",
      message: { role: "user", content: "continue", timestamp: 2 },
    });
    await waitFor(() => frames.length > 1, "a live delta frame");
    const live = ordinalsOf(frames);

    await h.adapter.resyncConversationV4({
      ...params,
      subscriptionId: subscription.ack.subscriptionId,
    });
    const recovery = frames.at(-1);
    assert.ok(recovery?.kind === "complete" && recovery.deliveryKind === "recovery");
    assert.ok(
      recovery.logicalFrameOrdinal > Math.max(...live),
      `recovery ordinal ${recovery.logicalFrameOrdinal} must exceed live ${live.join(",")}`,
    );
    assert.deepEqual(
      ordinalsOf(frames),
      [...ordinalsOf(frames)].sort((a, b) => a - b),
      "ordinals stay strictly increasing",
    );
  } finally {
    await h.adapter.dispose();
  }
});
