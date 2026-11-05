import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { NekSessionEntry, NekSessionMessageEntry } from "@zcode/shared/nek-protocol";
import {
  PROTOCOL_V4_LIMITS,
  v4AttachmentReadResultSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { nekUserImageRef } from "../src/nek-agent/projection/nekUserImages.js";
import { harness, params, sessionId } from "./nekSessionHarness.js";

function imageEntry(
  bytes = Buffer.from("image bytes split across chunks"),
): NekSessionMessageEntry {
  return {
    type: "message",
    id: "image-user",
    parentId: null,
    timestamp: new Date(1_001).toISOString(),
    message: {
      role: "user",
      timestamp: 1_000,
      content: [
        { type: "text", text: "look" },
        { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
      ],
    },
  };
}

async function projectedImage(h: ReturnType<typeof harness>) {
  const snapshot = await h.adapter.readNekSession(params);
  const row = snapshot.rows.window.find((candidate) => candidate.kind === "userInput");
  assert.ok(row?.kind === "userInput");
  const attachment = row.attachments?.[0];
  assert.ok(attachment);
  return {
    ...params,
    ref: attachment.ref,
    target: { rowId: row.rowId, entityId: row.entityId },
    attachmentIndex: 0,
  };
}

test("attachmentReadV4 resolves persisted images on demand and returns unaligned chunks", async () => {
  const bytes = randomBytes(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes + 17);
  const h = harness({ entries: [imageEntry(bytes)] });
  try {
    const image = await projectedImage(h);
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const result = v4AttachmentReadResultSchema.parse(
        await h.adapter.attachmentReadV4({
          ...params,
          ref: image.ref,
          offset,
          limit: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
        }),
      );
      assert.equal(result.totalBytes, bytes.length);
      assert.equal(result.mediaType, "image/png");
      chunks.push(Buffer.from(result.dataBase64, "base64"));
      if (result.nextOffset === null) break;
      assert.equal(result.nextOffset, PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes);
      offset = result.nextOffset;
    }
    assert.deepEqual(Buffer.concat(chunks), bytes);
    for (const [offset, limit] of [
      [1, 1],
      [2, 2],
      [3, 7],
      [bytes.length - 2, 10],
      [bytes.length, 7],
    ]) {
      const result = v4AttachmentReadResultSchema.parse(
        await h.adapter.attachmentReadV4({
          ...image,
          offset,
          limit,
        }),
      );
      assert.deepEqual(
        Buffer.from(result.dataBase64, "base64"),
        bytes.subarray(offset, offset + limit),
      );
      assert.equal(result.nextOffset, offset + limit < bytes.length ? offset + limit : null);
    }
    assert.ok(
      h.sessions[0]!.commands.filter(
        (command) => command.type === "get_entries" && command.limit === 1,
      ).length >= 7,
      "each read re-resolves; no retained image cache",
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("a live user image is readable before settlement and keeps its ref after close/reopen", async () => {
  const entries: NekSessionEntry[] = [];
  const h = harness({ entries });
  try {
    await h.adapter.readNekSession(params);
    const entry = imageEntry();
    entries.push(entry); // nek commits before emitting the user lifecycle events.
    h.sessions[0]!.emit({ type: "message_start", message: entry.message });
    const live = await projectedImage(h);
    const expected = await h.adapter.attachmentReadV4({ ...live, offset: 1, limit: 7 });
    assert.equal(Buffer.from(expected.dataBase64, "base64").toString(), "mage by");
    h.sessions[0]!.emit({ type: "message_end", message: entry.message });
    h.sessions[0]!.emit({ type: "agent_settled" });
    // Wait for the service's authoritative entry refresh, not for a model response.
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const row = (await h.adapter.readNekSession(params)).rows.window.find(
        (row) => row.kind === "userInput",
      );
      if (row?.entityId.startsWith("entry:")) break;
    }
    const persisted = await projectedImage(h);
    assert.ok(persisted.target.entityId.startsWith("entry:"));
    assert.notEqual(persisted.target.entityId, live.target.entityId);
    assert.equal(persisted.ref, live.ref);
    await h.adapter.closeNekSession(params);
    const reloaded = await projectedImage(h);
    assert.equal(reloaded.ref, live.ref);
    assert.deepEqual(
      await h.adapter.attachmentReadV4({ ...reloaded, offset: 1, limit: 7 }),
      expected,
    );
    assert.equal(h.sessions.length, 2);
  } finally {
    await h.adapter.dispose();
  }
});

test("image lookup pages through nek entries without keeping the session's base64 history", async () => {
  const image = imageEntry();
  const entries: NekSessionEntry[] = [
    image,
    ...Array.from(
      { length: 3 },
      (_, index): NekSessionEntry => ({
        type: "custom",
        id: `later-${index}`,
        parentId: index === 0 ? image.id : `later-${index - 1}`,
        timestamp: new Date(2_000 + index).toISOString(),
        customType: "test",
      }),
    ),
  ];
  const h = harness({ entries });
  try {
    const input = await projectedImage(h);
    await h.adapter.attachmentReadV4({ ...input, offset: 0, limit: 2 });
    const pages = h.sessions[0]!.commands.filter(
      (command) => command.type === "get_entries" && command.limit === 1,
    );
    assert.deepEqual(
      pages.map((command) => command.type === "get_entries" && command.beforeEntryId),
      [undefined, "later-2", "later-1", "later-0"],
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("conversation read/stat authorize the exact row attachment and share the image resolver", async () => {
  const bytes = Buffer.from("share this image");
  const h = harness({ entries: [imageEntry(bytes)] });
  try {
    const image = await projectedImage(h);
    const stat = v4ConversationAttachmentStatResultSchema.parse(
      await h.adapter.conversationAttachmentStatV4(image),
    );
    assert.deepEqual(stat, { mediaType: "image/png", totalBytes: bytes.length });
    const read = v4ConversationAttachmentReadResultSchema.parse(
      await h.adapter.conversationAttachmentReadV4({
        ...image,
        offset: 2,
        limit: 5,
      }),
    );
    assert.deepEqual(Buffer.from(read.dataBase64, "base64"), bytes.subarray(2, 7));
    for (const invalid of [
      { ...image, attachmentIndex: 1 },
      { ...image, target: { ...image.target, entityId: "another-row" } },
      { ...image, target: { ...image.target, rowId: image.target.rowId + 1 } },
      { ...image, ref: "another-image" },
    ]) {
      await assert.rejects(
        h.adapter.conversationAttachmentStatV4(invalid),
        /does not match conversation row/,
      );
      await assert.rejects(
        h.adapter.conversationAttachmentReadV4({ ...invalid, offset: 0, limit: 1 }),
        /does not match conversation row/,
      );
    }
  } finally {
    await h.adapter.dispose();
  }
});

test("unknown/cross-session refs, invalid chunk bounds and non-image blocks fail visibly", async () => {
  const entry = imageEntry();
  const h = harness({ entries: [entry] });
  try {
    const image = await projectedImage(h);
    assert.ok(entry.message.role === "user" && Array.isArray(entry.message.content));
    const block = entry.message.content[1];
    assert.ok(block?.type === "image");
    for (const ref of [
      "unknown",
      image.ref.replace(/.$/, image.ref.endsWith("a") ? "b" : "a"),
      nekUserImageRef("another-session", entry.message.timestamp, 1, block),
      nekUserImageRef(sessionId, entry.message.timestamp, 0, block),
      nekUserImageRef(sessionId, entry.message.timestamp, 999, block),
    ]) {
      await assert.rejects(
        h.adapter.attachmentReadV4({ ...params, ref, offset: 0, limit: 1 }),
        /Unknown nek image attachment ref/,
      );
    }
    for (const bounds of [
      { offset: -1, limit: 1 },
      { offset: 0, limit: 0 },
      { offset: 0, limit: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes + 1 },
    ]) {
      await assert.rejects(h.adapter.attachmentReadV4({ ...image, ...bounds }));
    }
    await assert.rejects(
      h.adapter.attachmentReadV4({ ...image, offset: 1_000, limit: 1 }),
      /offset exceeds/,
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("oversized historical images keep accurate stat metadata but reject preview reads", async () => {
  const bytes = Buffer.alloc(PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1);
  const h = harness({ entries: [imageEntry(bytes)] });
  try {
    const image = await projectedImage(h);
    assert.deepEqual(await h.adapter.conversationAttachmentStatV4(image), {
      mediaType: "image/png",
      totalBytes: bytes.length,
    });
    await assert.rejects(
      h.adapter.attachmentReadV4({ ...image, offset: 0, limit: 1 }),
      /exceeds 20 MB/,
    );
    await assert.rejects(
      h.adapter.conversationAttachmentReadV4({ ...image, offset: 0, limit: 1 }),
      /exceeds 20 MB/,
    );
  } finally {
    await h.adapter.dispose();
  }
});

test("locked sessions read existing snapshot images without spawning a writable session", async () => {
  const h = harness({
    entries: [imageEntry()],
    lockedBy: { pid: 123, hostname: "cli", kind: "tui", startedAt: new Date(0).toISOString() },
  });
  try {
    const image = await projectedImage(h);
    const result = await h.adapter.attachmentReadV4({ ...image, offset: 0, limit: 5 });
    assert.equal(Buffer.from(result.dataBase64, "base64").toString(), "image");
    assert.equal(h.sessions.length, 0);
    await assert.rejects(
      h.adapter.attachmentReadV4({
        ...params,
        ref: image.ref.replace(/.$/, "x"),
        offset: 0,
        limit: 1,
      }),
      /Unknown nek image attachment ref/,
    );
  } finally {
    await h.adapter.dispose();
  }
});
