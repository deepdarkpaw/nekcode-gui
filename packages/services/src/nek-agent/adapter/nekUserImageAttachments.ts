import { open } from "node:fs/promises";
import type { NekStoredAttachment } from "@zcode/shared/nek-protocol";
import {
  PROTOCOL_V4_LIMITS,
  v4AttachmentReadParamsSchema,
  v4AttachmentReadResultSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentStatParamsSchema,
  type V4AttachmentReadParams,
  type V4AttachmentReadResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService } from "../../zcode-agent/zcodeAgent.js";
import { nekImageByteLength } from "../projection/nekUserImages.js";
import type { NekAgentServiceAdapterLegacyTarget } from "./nekAgentServiceAdapterLegacySupport.js";
import type { NekWorkspaceTarget } from "./types.js";

/** Share 与预览共用会话授权；opaque ref 必须先解析为 nek 已持久化的图片或文件。 */
export function createNekUserImageAttachmentMethods(owner: NekAgentServiceAdapterLegacyTarget) {
  async function resolve(
    input: NekWorkspaceTarget,
    params: Pick<V4AttachmentReadParams, "sessionId" | "ref" | "target" | "attachmentIndex">,
  ) {
    const binding = await owner.ensureNekSessionBinding(input, params.sessionId);
    const rowTarget = params.target;
    if (rowTarget) {
      const rows = owner.service.conversationSnapshot(binding.sessionKey).rows.window;
      const row = rows.find(
        (candidate) =>
          candidate.rowId === rowTarget.rowId && candidate.entityId === rowTarget.entityId,
      );
      const attachment =
        row?.kind === "userInput" && params.attachmentIndex !== undefined
          ? row.attachments?.[params.attachmentIndex]
          : undefined;
      if (attachment?.ref !== params.ref)
        throw new Error("nek image attachment does not match conversation row target");
    }
    if (params.ref.startsWith("nek-file:")) {
      const file = await owner.service.readUserFile(binding.sessionKey, params.ref);
      return { kind: "file" as const, file, totalBytes: file.sizeBytes, mediaType: file.mimeType };
    }
    const image = await owner.service.readUserImage(binding.sessionKey, params.ref);
    return {
      kind: "image" as const,
      image,
      totalBytes: nekImageByteLength(image),
      mediaType: image.mimeType,
    };
  }

  async function read(
    input: NekWorkspaceTarget,
    params: V4AttachmentReadParams,
  ): Promise<V4AttachmentReadResult> {
    const result = await resolve(input, params);
    if (result.kind === "file")
      return await readStoredFile(result.file, params.offset, params.limit);
    const { image, totalBytes } = result;
    if (totalBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes)
      throw new Error("nek image exceeds 20 MB attachment limit");
    if (params.offset > totalBytes)
      throw new Error("nek image attachment offset exceeds total bytes");
    const end = Math.min(totalBytes, params.offset + params.limit);
    // base64 每 4 个字符编码 3 字节；仅解码本块，最多多出首尾各 2 个对齐字节。
    const startByte = Math.floor(params.offset / 3) * 3;
    const data = Buffer.from(
      image.data.slice((startByte / 3) * 4, Math.ceil(end / 3) * 4),
      "base64",
    );
    return {
      dataBase64: data.subarray(params.offset - startByte, end - startByte).toString("base64"),
      mediaType: image.mimeType,
      totalBytes,
      nextOffset: end < totalBytes ? end : null,
    };
  }

  const methods: Pick<
    IZCodeAgentService,
    "attachmentReadV4" | "conversationAttachmentReadV4" | "conversationAttachmentStatV4"
  > = {
    async attachmentReadV4(input) {
      const { sessionId, ref, target, attachmentIndex, offset, limit } = input;
      return v4AttachmentReadResultSchema.parse(
        await read(
          input,
          v4AttachmentReadParamsSchema.parse({
            sessionId,
            ref,
            target,
            attachmentIndex,
            offset,
            limit,
          }),
        ),
      );
    },
    async conversationAttachmentReadV4(input) {
      const { sessionId, ref, target, attachmentIndex, offset, limit } = input;
      return await read(
        input,
        v4ConversationAttachmentReadParamsSchema.parse({
          sessionId,
          ref,
          target,
          attachmentIndex,
          offset,
          limit,
        }),
      );
    },
    async conversationAttachmentStatV4(input) {
      const { sessionId, ref, target, attachmentIndex } = input;
      const params = v4ConversationAttachmentStatParamsSchema.parse({
        sessionId,
        ref,
        target,
        attachmentIndex,
      });
      const result = await resolve(input, params);
      if (result.kind === "file") await readStoredFile(result.file, 0, 0);
      return { mediaType: result.mediaType, totalBytes: result.totalBytes };
    },
  };
  return methods;
}

/** 授权后才打开稳定副本；每次只分配一个请求块，不把整份 PDF/文档读进 host。 */
async function readStoredFile(
  file: NekStoredAttachment,
  offset: number,
  limit: number,
): Promise<V4AttachmentReadResult> {
  const handle = await open(file.path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== file.sizeBytes)
      throw new Error("nek attachment file changed or is unavailable; reattach the file");
    if (offset > stat.size) throw new Error("nek file attachment offset exceeds total bytes");
    const length = Math.min(limit, stat.size - offset);
    const bytes = Buffer.alloc(length);
    let received = 0;
    while (received < length) {
      const result = await handle.read(bytes, received, length - received, offset + received);
      if (result.bytesRead === 0) throw new Error("nek attachment changed while reading");
      received += result.bytesRead;
    }
    return {
      dataBase64: bytes.toString("base64"),
      mediaType: file.mimeType,
      totalBytes: stat.size,
      nextOffset: offset + length < stat.size ? offset + length : null,
    };
  } finally {
    await handle.close();
  }
}
