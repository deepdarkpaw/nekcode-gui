import assert from "node:assert/strict";
import test from "node:test";
import type { NekSessionMessageEntry, NekUserMessage } from "@zcode/shared/nek-protocol";
import {
  applyConversationDeltas,
  conversationSnapshotSchema,
  conversationTopicFrameSchema,
  type ConversationSnapshot,
  type ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { NekConversationProjector } from "../src/nek-agent/nekConversationProjector.js";

const message: NekUserMessage = {
  role: "user",
  timestamp: 1_000,
  content: [
    { type: "text", text: "look at these" },
    { type: "image", mimeType: "image/png", data: "AQIDBA==" },
    { type: "text", text: "and this" },
    { type: "image", mimeType: "image/jpeg", data: "BQY=" },
  ],
};
const entry: NekSessionMessageEntry = {
  type: "message",
  id: "persisted-user-id",
  parentId: null,
  timestamp: new Date(1_001).toISOString(),
  message,
};

function projector(sessionId = "session-images") {
  return new NekConversationProjector({ sessionId, schedule: () => () => undefined });
}

function userRow(snapshot: ConversationSnapshot) {
  const row = snapshot.rows.window.find((candidate) => candidate.kind === "userInput");
  assert.ok(row?.kind === "userInput");
  return row;
}

function replay(frames: ConversationTopicFrame[]): ConversationSnapshot {
  let client: ConversationSnapshot | undefined;
  for (const candidate of frames) {
    const frame = conversationTopicFrameSchema.parse(candidate);
    if (frame.payload.kind === "snapshot") client = frame.payload.snapshot;
    else {
      assert.ok(client);
      client = { ...applyConversationDeltas(client, frame.payload.deltas), seq: frame.toSeq };
    }
    conversationSnapshotSchema.parse(client);
  }
  assert.ok(client);
  return client;
}

test("user images survive live → persisted entry handoff and reload with schema-valid refs", () => {
  const live = projector();
  const frames: ConversationTopicFrame[] = [];
  live.subscribe((frame) => frames.push(frame));
  live.handleEvent({ type: "message_start", message });
  live.handleEvent({ type: "message_end", message });
  live.flushNow();
  let client = replay(frames);
  const user = userRow(client);
  assert.equal(user.text, "look at theseand this");
  assert.deepEqual(
    user.attachments?.map(({ fileName, mime, bytes }) => ({ fileName, mime, bytes })),
    [
      { fileName: "image-1.png", mime: "image/png", bytes: 4 },
      { fileName: "image-2.jpg", mime: "image/jpeg", bytes: 2 },
    ],
  );
  assert.match(user.attachments![0]!.ref, /^nek-image:1000:1:[a-f0-9]{64}$/);
  assert.match(user.attachments![1]!.ref, /^nek-image:1000:3:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(client).includes("AQIDBA=="), "rows never contain image bytes");

  live.loadSnapshot({ entries: [entry], leafId: entry.id });
  client = replay(frames);
  const persisted = userRow(client);
  assert.notEqual(persisted.entityId, user.entityId, "entry and live row identities differ");
  assert.deepEqual(
    persisted.attachments,
    user.attachments,
    "refs must not depend on entry ID/time",
  );
  assert.equal(client.rows.window.filter((row) => row.kind === "userInput").length, 1);

  const reloaded = projector();
  reloaded.loadSnapshot({ entries: [entry], leafId: entry.id });
  assert.deepEqual(userRow(reloaded.snapshot()).attachments, user.attachments);
  const otherSession = projector("other-session");
  otherSession.loadSnapshot({ entries: [entry], leafId: entry.id });
  assert.notEqual(userRow(otherSession.snapshot()).attachments![0]!.ref, user.attachments![0]!.ref);
  live.dispose();
  reloaded.dispose();
  otherSession.dispose();
});

test("image-only input is projected and text-only inputs keep their existing shape", () => {
  for (const content of ["only text", [{ type: "text" as const, text: "only text" }]]) {
    const p = projector();
    p.handleEvent({ type: "message_start", message: { ...message, content } });
    const row = userRow(p.snapshot());
    assert.equal(row.text, "only text");
    assert.equal(row.attachments, undefined);
    p.dispose();
  }
  const p = projector();
  p.loadSnapshot({
    entries: [
      {
        ...entry,
        message: { ...message, content: [{ type: "image", mimeType: "image/webp", data: "AQID" }] },
      },
    ],
  });
  const row = userRow(conversationSnapshotSchema.parse(p.snapshot()));
  assert.equal(row.text, "");
  assert.equal(row.attachments?.[0]?.fileName, "image-1.webp");
  assert.equal(row.attachments?.[0]?.bytes, 3);
  p.dispose();
});

test("malformed source image blocks fail visibly instead of producing broken metadata", () => {
  const p = projector();
  assert.throws(
    () =>
      p.loadSnapshot({
        entries: [
          {
            ...entry,
            message: {
              ...message,
              content: [{ type: "image", mimeType: "image/png", data: "not base64!" }],
            },
          },
        ],
      }),
    /Invalid nek image base64/,
  );
  p.dispose();
});
