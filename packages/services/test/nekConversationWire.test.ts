import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationTopicFrameSchema,
  measureTopicNotificationEnvelopeBytes,
  PROTOCOL_V4_LIMITS,
  TopicWireFrameAssembler,
  type ConversationTopicWireCandidate,
  type ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { entry, harness, params, target } from "./nekSessionHarness.js";

const text = "历史输出🙂\n".repeat(12_000);
const entries = Array.from({ length: 8 }, (_, index) => ({
  ...entry,
  id: `history-${index}`,
  parentId: index === 0 ? null : `history-${index - 1}`,
  message: { ...entry.message, content: `${index}:${text}` },
}));

function decode(
  frames: ConversationTopicWireCandidate[],
  assembler: TopicWireFrameAssembler<ConversationTopicFrame>,
) {
  assert.ok(frames.length > 1, "large logical frames must be fragmented");
  assert.equal(new Set(frames.map((frame) => frame.logicalFrameOrdinal)).size, 1);
  assert.equal(new Set(frames.map((frame) => frame.logicalFrameId)).size, 1);
  const events = frames.flatMap((frame) => {
    assert.ok(
      measureTopicNotificationEnvelopeBytes(frame).maxBytes <= PROTOCOL_V4_LIMITS.maxFrameBytes,
    );
    assert.equal(frame.kind, "fragment");
    return assembler.accept(frame);
  });
  assert.equal(events.length, 1, "all fragments produce exactly one logical frame, with no faults");
  const complete = events[0]!;
  assert.equal(complete.kind, "complete");
  if (complete.kind !== "complete") throw new Error("frame assembly failed");
  return complete.frame;
}

for (const locked of [false, true]) {
  test(`S1/S2: large CLI history survives initial and recovery delivery (locked=${locked})`, async () => {
    const h = harness({
      entries,
      ...(locked
        ? {
            lockedBy: {
              pid: 42,
              hostname: "terminal",
              kind: "tui" as const,
              startedAt: entry.timestamp,
            },
          }
        : {}),
    });
    const frames: ConversationTopicWireCandidate[] = [];
    h.adapter.onDynamicConversationFrame(target)((frame) => frames.push(frame));
    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    try {
      const { ack } = await h.adapter.subscribeConversationV4(params);
      assert.ok(frames.every((frame) => frame.deliveryKind === "initial"));
      const initialOrdinal = frames[0]!.logicalFrameOrdinal;
      const initial = decode(frames.splice(0), assembler);
      assert.equal(initial.payload.kind, "snapshot");
      if (initial.payload.kind !== "snapshot") throw new Error("expected snapshot");
      const restored = await h.adapter.readNekSession(params);
      assert.deepEqual(initial.payload.snapshot.rows, restored.rows);
      assert.deepEqual(
        restored.rows.window.flatMap((row) => (row.kind === "userInput" ? [row.text] : [])),
        entries.map((item) => item.message.content),
        "history is preserved without truncation",
      );
      assert.equal(h.sessions.length, locked ? 0 : 1);
      await h.adapter.resyncConversationV4({ ...params, subscriptionId: ack.subscriptionId });
      assert.ok(frames.every((frame) => frame.deliveryKind === "recovery"));
      assert.ok(frames[0]!.logicalFrameOrdinal > initialOrdinal);
      const recovery = decode(frames.splice(0), assembler);
      assert.deepEqual(recovery.payload, initial.payload);
    } finally {
      await h.adapter.dispose();
    }
  });
}

test("S2: oversized live deltas use the same logical sequence as initial and recovery", async () => {
  const h = harness();
  const frames: ConversationTopicWireCandidate[] = [];
  h.adapter.onDynamicConversationFrame(target)((frame) => frames.push(frame));
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  try {
    const { ack } = await h.adapter.subscribeConversationV4(params);
    assert.equal(frames[0]?.kind, "complete", "small snapshots remain complete frames");
    const initialOrdinal = frames[0]!.logicalFrameOrdinal;
    for (const frame of frames.splice(0)) assembler.accept(frame);
    h.sessions[0]!.emit({
      type: "message_start",
      message: {
        role: "user",
        content: text.repeat(8),
        timestamp: 2,
      },
    });
    const deadline = Date.now() + 2_000;
    while (frames.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(frames.every((frame) => frame.deliveryKind === "online"));
    const liveOrdinal = frames[0]!.logicalFrameOrdinal;
    assert.ok(liveOrdinal > initialOrdinal);
    assert.equal(decode(frames.splice(0), assembler).payload.kind, "deltas");
    await h.adapter.resyncConversationV4({ ...params, subscriptionId: ack.subscriptionId });
    assert.ok(frames[0]!.logicalFrameOrdinal > liveOrdinal);
    assert.equal(decode(frames, assembler).payload.kind, "snapshot");
  } finally {
    await h.adapter.dispose();
  }
});
