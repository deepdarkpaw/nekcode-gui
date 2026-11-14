import assert from "node:assert/strict";
import test from "node:test";
import { streamAppendJsonBytes } from "../src/nek-agent/projection/nekProjectionBytes.js";
import { buildAssistantTextRow } from "../src/nek-agent/projection/nekRows.js";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";

for (const [before, append] of [
  ["prefix", "suffix"],
  ["中文", '\n"🙂'],
  ["\ud83d", "\ude42"],
  ["\ud83d", "x"],
  ["", "\ud83d"],
]) {
  test(`HS6: incremental JSON bytes equal actual encoded growth (${JSON.stringify(before)}, ${JSON.stringify(append)})`, () => {
    const row = buildAssistantTextRow(
      { rowId: 1, entityId: "text", turnId: "turn", createdAt: 1 },
      { text: before, state: "streaming" },
    );
    const actual =
      Buffer.byteLength(JSON.stringify({ ...row, text: before + append })) -
      Buffer.byteLength(JSON.stringify(row));
    assert.equal(streamAppendJsonBytes(row, "text", append), actual);
  });
}

test("HS6: streaming byte admission never reserializes the already-rendered text prefix", (t) => {
  const projector = new NekConversationProjector({ sessionId: "s", schedule: () => () => {} });
  try {
    projector.handleEvent({
      type: "message_start",
      message: { role: "assistant", timestamp: 1, provider: "test", model: "test", content: [] },
    });
    const prefix = "prefix".repeat(20_000);
    projector.handleEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: prefix },
    });
    projector.flushNow();
    const stringify = JSON.stringify;
    t.mock.method(JSON, "stringify", (value: unknown, ...args: unknown[]) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === "assistantText"
      )
        throw new Error("stream prefix was reserialized");
      return Reflect.apply(stringify, JSON, [value, ...args]);
    });
    for (let index = 0; index < 20; index++)
      projector.handleEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "+" },
      });
    const row = projector.snapshot().rows.window.find((row) => row.kind === "assistantText");
    assert.equal(row?.text, prefix + "+".repeat(20));
  } finally {
    projector.dispose();
  }
});
