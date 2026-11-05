import {
  PROTOCOL_V4_LIMITS,
  v4AttachmentReadParamsSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentStatParamsSchema,
  type V4AttachmentReadParams,
  type V4AttachmentReadResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService } from "../../zcode-agent/zcodeAgent.js";
import { nekImageByteLength } from "../projection/nekUserImages.js";
import type { NekAgentServiceAdapterLegacyTarget } from "./nekAgentServiceAdapterLegacySupport.js";
import type { NekWorkspaceTarget } from "./types.js";

/** Share 与媒体预览共用同一会话解析路径；不维护图片副本或按 ref 访问磁盘。 */
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
    const image = await owner.service.readUserImage(binding.sessionKey, params.ref);
    return { image, totalBytes: nekImageByteLength(image) };
  }

  async function read(
    input: NekWorkspaceTarget,
    params: V4AttachmentReadParams,
  ): Promise<V4AttachmentReadResult> {
    const { image, totalBytes } = await resolve(input, params);
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
      return await read(
        input,
        v4AttachmentReadParamsSchema.parse({
          sessionId,
          ref,
          target,
          attachmentIndex,
          offset,
          limit,
        }),
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
      return { mediaType: result.image.mimeType, totalBytes: result.totalBytes };
    },
  };
  return methods;
}
