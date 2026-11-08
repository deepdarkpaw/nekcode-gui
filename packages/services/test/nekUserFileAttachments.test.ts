import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type {
  NekCustomMessageEntry,
  NekSessionEntry,
  NekStoredAttachment,
} from "@zcode/shared/nek-protocol";
import {
  PROTOCOL_V4_LIMITS,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { nekUserFileRef } from "../src/nek-agent/projection/nekUserFiles.js";
import { harness, params, sessionId } from "./nekSessionHarness.js";

async function withFile(run: (file: NekStoredAttachment, bytes: Buffer) => Promise<void>) {
  const root = fileURLToPath(new URL("../../../.tmp/", import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "persisted-attachment-"));
  const bytes = randomBytes(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes + 31);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const path = join(directory, sha256, "report.pdf");
  await mkdir(join(directory, sha256));
  await writeFile(path, bytes);
  try {
    await run(
      {
        path,
        fileName: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: bytes.length,
        sha256,
      },
      bytes,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function entriesFor(file: NekStoredAttachment): NekSessionEntry[] {
  return [
    {
      type: "message",
      id: "user-file",
      parentId: null,
      timestamp: new Date(1).toISOString(),
      message: { role: "user", timestamp: 1, content: "summarize the attachment" },
    },
    {
      type: "custom_message",
      id: "metadata-file",
      parentId: "user-file",
      timestamp: new Date(2).toISOString(),
      customType: "nek.attachments",
      display: false,
      content: "INTERNAL_ATTACHMENT_CONTENT",
      details: { version: 1, attachments: [file] },
    },
  ];
}

async function projectedFile(h: ReturnType<typeof harness>) {
  const snapshot = await h.adapter.readNekSession(params);
  const row = snapshot.rows.window.find((row) => row.kind === "userInput");
  assert.ok(row?.kind === "userInput");
  assert.equal(row.text, "summarize the attachment");
  assert.equal(row.attachments?.length, 1);
  const file = row.attachments[0]!;
  assert.equal(file.fileName, "report.pdf");
  assert.match(file.ref, /^nek-file:[a-f0-9]{64}$/);
  return {
    ...params,
    ref: file.ref,
    target: { rowId: row.rowId, entityId: row.entityId },
    attachmentIndex: 0,
  };
}

test("persisted files project original text and support authorized bounded read/stat after reopen", async () => {
  await withFile(async (file, bytes) => {
    const h = harness({ entries: entriesFor(file) });
    try {
      const target = await projectedFile(h);
      assert.deepEqual(
        v4ConversationAttachmentStatResultSchema.parse(
          await h.adapter.conversationAttachmentStatV4(target),
        ),
        { mediaType: "application/pdf", totalBytes: bytes.length },
      );
      let offset = 0;
      const parts: Buffer[] = [];
      for (;;) {
        const part = v4ConversationAttachmentReadResultSchema.parse(
          await h.adapter.conversationAttachmentReadV4({
            ...target,
            offset,
            limit: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
          }),
        );
        parts.push(Buffer.from(part.dataBase64, "base64"));
        if (part.nextOffset === null) break;
        offset = part.nextOffset;
      }
      assert.deepEqual(Buffer.concat(parts), bytes);
      await h.adapter.closeNekSession(params);
      const reopened = await projectedFile(h);
      assert.equal(reopened.ref, target.ref);
      const part = await h.adapter.attachmentReadV4({ ...reopened, offset: 3, limit: 17 });
      assert.deepEqual(Buffer.from(part.dataBase64, "base64"), bytes.subarray(3, 20));
      const snapshot = await h.adapter.readNekSession(params);
      assert.ok(!JSON.stringify(snapshot.rows.window).includes("INTERNAL_ATTACHMENT_CONTENT"));
      assert.ok(
        !JSON.stringify(snapshot.rows.window).includes(file.path),
        "opaque refs do not expose storage paths",
      );
      await h.adapter.sendNekConversationCommandV4({
        target: params,
        envelope: {
          commandId: "reuse-file",
          clientId: "test",
          sessionId,
          type: "sendText",
          issuedAt: 1,
          payload: {
            text: "read again",
            attachments: [
              {
                ref: reopened.ref,
                fileName: file.fileName,
                mime: file.mimeType,
                bytes: file.sizeBytes,
              },
            ],
          },
        },
      });
      const prompt = h.sessions.at(-1)!.commands.find((command) => command.type === "prompt");
      assert.ok(prompt?.type === "prompt");
      assert.deepEqual(prompt.attachments, [
        { path: file.path, fileName: file.fileName, mimeType: file.mimeType },
      ]);
    } finally {
      await h.adapter.dispose();
    }
  });
});

test("file reads reject cross-session/unknown refs, arbitrary paths and mismatched row targets", async () => {
  await withFile(async (file) => {
    const h = harness({ entries: entriesFor(file) });
    try {
      const target = await projectedFile(h);
      for (const invalid of [
        { ...target, ref: nekUserFileRef("another-session", file) },
        { ...target, attachmentIndex: 1 },
        { ...target, target: { ...target.target, entityId: "another-row" } },
        { ...target, ref: file.path },
      ]) {
        await assert.rejects(
          h.adapter.conversationAttachmentReadV4({ ...invalid, offset: 0, limit: 1 }),
          /does not match conversation row/,
        );
      }
      for (const ref of [nekUserFileRef("another-session", file), `nek-file:${"0".repeat(64)}`]) {
        await assert.rejects(
          h.adapter.attachmentReadV4({ ...params, ref, offset: 0, limit: 1 }),
          /Unknown nek file attachment/,
        );
      }
      await assert.rejects(
        h.adapter.attachmentReadV4({ ...target, offset: file.sizeBytes + 1, limit: 1 }),
        /offset exceeds/,
      );
      await writeFile(file.path, "changed");
      await assert.rejects(h.adapter.conversationAttachmentStatV4(target), /file changed/);
    } finally {
      await h.adapter.dispose();
    }
  });
});

test("live attachment metadata updates its user once and reconstructs identically from persisted entries", async () => {
  await withFile(async (file) => {
    const entries: NekSessionEntry[] = [];
    const h = harness({ entries });
    try {
      await h.adapter.readNekSession(params);
      const input = entriesFor(file);
      entries.push(...input);
      const user = input[0]!;
      const metadata = input[1] as NekCustomMessageEntry;
      assert.equal(user.type, "message");
      if (user.type !== "message") throw new Error("fixture");
      const message = {
        role: "custom",
        customType: metadata.customType,
        display: false,
        content: metadata.content,
        details: metadata.details,
        timestamp: 2,
      };
      h.sessions[0]!.emit({ type: "message_start", message: user.message });
      h.sessions[0]!.emit({ type: "message_end", message: user.message });
      h.sessions[0]!.emit({ type: "message_start", message });
      h.sessions[0]!.emit({ type: "message_end", message });
      const live = await projectedFile(h);
      assert.equal(live.ref, nekUserFileRef(sessionId, file));
      await h.adapter.closeNekSession(params);
      const restored = await projectedFile(h);
      assert.equal(restored.ref, live.ref);
    } finally {
      await h.adapter.dispose();
    }
  });
});

test("locked sessions authorize file metadata from the existing read-only snapshot", async () => {
  await withFile(async (file, bytes) => {
    const h = harness({
      entries: entriesFor(file),
      lockedBy: {
        pid: 1,
        hostname: "cli",
        kind: "tui",
        startedAt: new Date(0).toISOString(),
      },
    });
    try {
      const target = await projectedFile(h);
      const read = await h.adapter.attachmentReadV4({ ...target, offset: 0, limit: 8 });
      assert.deepEqual(Buffer.from(read.dataBase64, "base64"), bytes.subarray(0, 8));
      assert.equal(h.sessions.length, 0);
    } finally {
      await h.adapter.dispose();
    }
  });
});
