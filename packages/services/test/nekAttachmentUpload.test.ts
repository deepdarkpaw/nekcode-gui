/**
 * 粘贴截图（没有本地路径）的发送链路：渲染层经连接 facade 分片上传，commit 得到 ref，
 * sendText 带上 ref 后 nek 收到 inline 图片。此前四个上传方法在 nek 模式一律报
 * “不支持”，附件显示红色感叹号、无法发送。
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import { createZCodeAgentConnectionScope } from "../src/zcode-agent/zcodeAgentConnectionScope.js";
import { harness, sessionId, target } from "./nekSessionHarness.js";

const CLIENT_ID = "renderer-test";

async function connectedScope(h: ReturnType<typeof harness>) {
  const scope = createZCodeAgentConnectionScope(h.adapter, {
    connectionId: "renderer-connection",
    clientMode: "desktop-continuous",
  });
  await scope.service.helloConversationV4();
  await scope.service.initializeConversationV4({
    kind: "clientHello",
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    clientId: CLIENT_ID,
    appVersion: "test",
  });
  return scope;
}

function declaration(bytes: Buffer, uploadId: string) {
  return {
    ...target,
    sessionId,
    uploadId,
    fileName: "pasted-image.png",
    mime: "image/png",
    totalBytes: bytes.length,
    totalChunks: 2,
    checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

test("GI-1: a pasted image uploads through the connection facade and reaches nek through images", async () => {
  const stagingDir = await mkdtemp(join(tmpdir(), "nek-attachment-upload-"));
  const h = harness({ attachmentStagingDir: stagingDir });
  const scope = await connectedScope(h);
  try {
    const bytes = randomBytes(2_048);
    const upload = declaration(bytes, "upload-pasted");
    const begin = await scope.service.attachmentBeginV4(upload);
    assert.equal(begin.state, "staging");
    // 传输拥塞时 facade 会把 saturated 转发给 agent；nek 必须接受，而不是让上传失败。
    await scope.setTransportFlowState("saturated");
    const half = bytes.length / 2;
    for (const [chunkIndex, chunk] of [bytes.subarray(0, half), bytes.subarray(half)].entries()) {
      await scope.service.attachmentChunkV4({
        ...target,
        sessionId,
        uploadId: upload.uploadId,
        chunkIndex,
        dataBase64: chunk.toString("base64"),
      });
    }
    await scope.setTransportFlowState("drained");
    const { ref } = await scope.service.attachmentCommitV4({
      ...target,
      sessionId,
      uploadId: upload.uploadId,
    });

    const ack = await scope.service.sendConversationCommandV4({
      ...target,
      envelope: {
        commandId: "send-with-image",
        clientId: CLIENT_ID,
        sessionId,
        type: "sendText",
        payload: {
          text: "what is in this screenshot?",
          attachments: [{ ref, fileName: upload.fileName, mime: upload.mime, bytes: bytes.length }],
        },
        issuedAt: 1,
      },
    });
    assert.equal(ack.status, "accepted");
    const prompt = h.sessions[0]?.commands.find((command) => command.type === "prompt");
    assert.ok(prompt && prompt.type === "prompt", "nek received the prompt");
    assert.deepEqual(prompt.images, [
      { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
    ]);
    assert.equal(
      prompt.attachments,
      undefined,
      "images do not require the new ordinary-file capability",
    );
  } finally {
    await scope.dispose();
    await h.adapter.dispose();
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("closing the renderer connection abandons its unfinished uploads", async () => {
  const stagingDir = await mkdtemp(join(tmpdir(), "nek-attachment-close-"));
  const h = harness({ attachmentStagingDir: stagingDir });
  const scope = await connectedScope(h);
  try {
    const bytes = randomBytes(512);
    const upload = declaration(bytes, "upload-abandoned");
    await scope.service.attachmentBeginV4(upload);
    await scope.dispose();
    await assert.rejects(
      h.adapter.attachmentChunkV4({
        ...target,
        sessionId,
        uploadId: upload.uploadId,
        chunkIndex: 0,
        dataBase64: bytes.subarray(0, 256).toString("base64"),
      }),
      /fault\.attachment\.unknownUpload/,
    );
  } finally {
    await h.adapter.dispose();
    await rm(stagingDir, { recursive: true, force: true });
  }
});
