/** 粘贴图片的 v4 上传事务暂存：分片、校验、幂等重试与有界清理。 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { toNekImages } from "../src/nek-agent/adapter/attachmentImages.js";
import {
  NEK_ATTACHMENT_IMAGE_ONLY_MESSAGE,
  NEK_ATTACHMENT_MAX_COMMITTED_UPLOADS,
  NEK_ATTACHMENT_STAGING_FULL_MESSAGE,
  NekAttachmentStaging,
  type NekAttachmentBeginInput,
} from "../src/nek-agent/adapter/nekAttachmentStaging.js";

const MB = 1024 * 1024;

function declare(
  bytes: Buffer,
  overrides: Partial<NekAttachmentBeginInput> = {},
): NekAttachmentBeginInput {
  return {
    sessionId: "session-1",
    uploadId: "upload-1",
    fileName: "screenshot.png",
    mime: "image/png",
    totalBytes: bytes.length,
    totalChunks: Math.min(3, bytes.length),
    checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    ...overrides,
  };
}

function slices(bytes: Buffer, count: number): Buffer[] {
  const size = Math.ceil(bytes.length / count);
  return Array.from({ length: count }, (_, index) =>
    bytes.subarray(index * size, Math.min(bytes.length, (index + 1) * size)),
  );
}

async function upload(
  staging: NekAttachmentStaging,
  input: NekAttachmentBeginInput,
  bytes: Buffer,
  connectionId?: string,
): Promise<string> {
  await staging.begin(input, connectionId);
  for (const [chunkIndex, chunk] of slices(bytes, input.totalChunks).entries()) {
    await staging.chunk({ ...input, chunkIndex, dataBase64: chunk.toString("base64") });
  }
  return (await staging.commit(input)).ref;
}

async function withStaging(
  run: (context: {
    staging: NekAttachmentStaging;
    rootDir: string;
    clock: { now: number };
  }) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "nek-attachment-staging-"));
  const clock = { now: Date.now() };
  const staging = new NekAttachmentStaging({ rootDir, now: () => clock.now });
  try {
    await run({ staging, rootDir, clock });
  } finally {
    await staging.dispose();
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("stages chunks and commits a checksum-verified image that nek can read", async () => {
  await withStaging(async ({ staging }) => {
    const bytes = randomBytes(1_000);
    const input = declare(bytes);
    assert.deepEqual(await staging.begin(input), {
      uploadId: input.uploadId,
      state: "staging",
      nextChunkIndex: 0,
    });
    const [first, second, third] = slices(bytes, 3);
    assert.ok(first && second && third);
    const chunk0 = { ...input, chunkIndex: 0, dataBase64: first.toString("base64") };
    assert.equal((await staging.chunk(chunk0)).nextChunkIndex, 1);
    // ACK 丢失后的重复分片不会重复写入。
    assert.equal((await staging.chunk(chunk0)).nextChunkIndex, 1);
    await staging.chunk({ ...input, chunkIndex: 1, dataBase64: second.toString("base64") });
    await staging.chunk({ ...input, chunkIndex: 2, dataBase64: third.toString("base64") });
    const { ref } = await staging.commit(input);
    assert.deepEqual(await readFile(ref), bytes);
    assert.deepEqual(await toNekImages([{ ref, mime: "image/png" }]), [
      { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
    ]);

    // begin / commit 重试幂等：拿回同一个 ref。
    assert.deepEqual(await staging.begin(input), {
      uploadId: input.uploadId,
      state: "committed",
      nextChunkIndex: input.totalChunks,
      ref,
    });
    assert.deepEqual(await staging.commit(input), { ref });
  });
});

test("rejects non-images, conflicting retries, bad chunks and checksum mismatches", async () => {
  await withStaging(async ({ staging }) => {
    const bytes = randomBytes(600);
    await assert.rejects(
      staging.begin(declare(bytes, { mime: "text/plain" })),
      new Error(NEK_ATTACHMENT_IMAGE_ONLY_MESSAGE),
    );
    await assert.rejects(
      staging.begin(declare(bytes, { totalBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1 })),
      /proto\.payloadTooLarge/,
    );

    const input = declare(bytes);
    await staging.begin(input);
    await assert.rejects(
      staging.begin({ ...input, checksum: `sha256:${"0".repeat(64)}` }),
      /fault\.attachment\.uploadConflict/,
    );
    await assert.rejects(
      staging.chunk({ ...input, chunkIndex: 2, dataBase64: "AAAA" }),
      /fault\.attachment\.chunkOutOfOrder/,
    );
    await assert.rejects(
      staging.chunk({ ...input, chunkIndex: 0, dataBase64: "abc" }),
      /proto\.invalidBase64/,
    );
    await assert.rejects(staging.commit(input), /fault\.attachment\.incomplete/);

    const other = randomBytes(600);
    const mismatched = declare(other, { uploadId: "upload-2", checksum: input.checksum });
    await assert.rejects(upload(staging, mismatched, other), /fault\.attachment\.checksumMismatch/);
    await assert.rejects(
      staging.chunk({ ...mismatched, chunkIndex: 0, dataBase64: "AAAA" }),
      /fault\.attachment\.unknownUpload/,
    );
  });
});

test("keeps in-flight uploads within protocol bounds and expires abandoned ones", async () => {
  await withStaging(async ({ staging, clock }) => {
    const large = (uploadId: string): NekAttachmentBeginInput => ({
      ...declare(Buffer.alloc(1)),
      uploadId,
      totalBytes: 20 * MB,
      totalChunks: 40,
    });
    for (const uploadId of ["big-1", "big-2", "big-3"]) await staging.begin(large(uploadId));
    await assert.rejects(
      staging.begin(large("big-4")),
      new Error(NEK_ATTACHMENT_STAGING_FULL_MESSAGE),
    );

    // 半途放弃的上传超时后作废，名额回收。
    clock.now += PROTOCOL_V4_LIMITS.attachmentUploadTtlMs;
    const small = (uploadId: string) => declare(Buffer.alloc(4), { uploadId, totalChunks: 1 });
    for (let index = 0; index < PROTOCOL_V4_LIMITS.attachmentUploadMaxConcurrent; index += 1) {
      await staging.begin(small(`small-${index}`));
    }
    await assert.rejects(
      staging.chunk({ ...large("big-1"), chunkIndex: 0, dataBase64: "AAAA" }),
      /fault\.attachment\.unknownUpload/,
    );
    await assert.rejects(
      staging.begin(small("one-too-many")),
      new Error(NEK_ATTACHMENT_STAGING_FULL_MESSAGE),
    );
  });
});

test("evicts the least recently used committed images beyond the cap", async () => {
  await withStaging(async ({ staging, clock }) => {
    const refs: string[] = [];
    for (let index = 0; index <= NEK_ATTACHMENT_MAX_COMMITTED_UPLOADS; index += 1) {
      clock.now += 1;
      const bytes = Buffer.from([index % 256]);
      refs.push(
        await upload(staging, declare(bytes, { uploadId: `u-${index}`, totalChunks: 1 }), bytes),
      );
    }
    assert.equal(existsSync(refs[0] ?? ""), false, "oldest committed image is evicted");
    assert.ok(refs.slice(1).every((ref) => existsSync(ref)));
  });
});

test("closing a connection drops its in-flight uploads but keeps committed images", async () => {
  await withStaging(async ({ staging }) => {
    const bytes = randomBytes(300);
    const committed = await upload(staging, declare(bytes, { uploadId: "done" }), bytes, "c1");
    const pending = declare(bytes, { uploadId: "pending" });
    await staging.begin(pending, "c1");
    const otherConnection = declare(bytes, { uploadId: "other" });
    await staging.begin(otherConnection, "c2");

    await staging.closeConnection("c1");
    assert.ok(existsSync(committed));
    await assert.rejects(
      staging.chunk({ ...pending, chunkIndex: 0, dataBase64: "AAAA" }),
      /fault\.attachment\.unknownUpload/,
    );
    assert.equal((await staging.begin(otherConnection, "c2")).state, "staging");
  });
});

test("dispose removes this instance's files and stale instance directories are swept", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "nek-attachment-sweep-"));
  try {
    const stale = join(rootDir, "1234-stale");
    const fresh = join(rootDir, "5678-fresh");
    await mkdir(stale);
    await mkdir(fresh);
    const old = (Date.now() - PROTOCOL_V4_LIMITS.attachmentUnreferencedTtlMs - 60_000) / 1000;
    await utimes(stale, old, old);

    const staging = new NekAttachmentStaging({ rootDir });
    const bytes = randomBytes(64);
    const ref = await upload(staging, declare(bytes, { totalChunks: 1 }), bytes);
    assert.deepEqual((await readdir(rootDir)).includes("1234-stale"), false);
    assert.ok(existsSync(fresh), "directories within the retention window stay");

    await staging.dispose();
    assert.equal(existsSync(ref), false);
    await assert.rejects(staging.begin(declare(bytes)), /fault\.attachment\.stagingClosed/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
