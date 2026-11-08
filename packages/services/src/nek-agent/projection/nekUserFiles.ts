import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  NEK_PROMPT_ATTACHMENT_LIMITS,
  type NekSessionEntry,
  type NekStoredAttachment,
} from "@zcode/shared/nek-protocol";
import type { AttachmentRef, UserInputRow } from "@zcode/shared/zcode-protocol-v4";

/** 仅消费 nek 明确持久化的结构化事实，绝不从用户正文或路径提示中猜附件。 */
export function readNekStoredAttachments(value: {
  customType?: string;
  display?: boolean;
  details?: unknown;
}): NekStoredAttachment[] | undefined {
  if (value.customType !== "nek.attachments") return undefined;
  const details = value.details as { version?: unknown; attachments?: unknown } | undefined;
  if (value.display !== false || details?.version !== 1 || !Array.isArray(details.attachments))
    throw new Error("Invalid nek attachment metadata");
  if (details.attachments.length > NEK_PROMPT_ATTACHMENT_LIMITS.maxCount)
    throw new Error("Too many nek attachments");
  return details.attachments.map((item: unknown) => {
    if (typeof item !== "object" || item === null)
      throw new Error("Invalid nek attachment metadata");
    const file = item as NekStoredAttachment;
    if (
      typeof file.path !== "string" ||
      !isAbsolute(file.path) ||
      typeof file.fileName !== "string" ||
      !file.fileName ||
      file.fileName.length > 255 ||
      ["\0", "\r", "\n"].some((char) => file.fileName.includes(char)) ||
      typeof file.mimeType !== "string" ||
      !file.mimeType ||
      file.mimeType.length > 255 ||
      ["\0", "\r", "\n"].some((char) => file.mimeType.includes(char)) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      file.sizeBytes > NEK_PROMPT_ATTACHMENT_LIMITS.maxFileBytes ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      throw new Error("Invalid nek attachment metadata");
    return {
      path: file.path,
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    };
  });
}

/** opaque ref 同时绑定会话、稳定文件路径和内容；不是可直接打开的磁盘地址。 */
export function nekUserFileRef(sessionId: string, file: NekStoredAttachment): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        sessionId,
        file.path,
        file.fileName,
        file.mimeType,
        file.sizeBytes,
        file.sha256,
      ]),
    )
    .digest("hex");
  return `nek-file:${digest}`;
}

/** 图片由原始 image blocks 投影，避免把同一张图片再显示成一个文件附件。 */
export function projectNekUserFiles(
  sessionId: string,
  files: NekStoredAttachment[],
): AttachmentRef[] {
  return files
    .filter((file) => !file.mimeType.toLowerCase().startsWith("image/"))
    .map((file) => ({
      ref: nekUserFileRef(sessionId, file),
      fileName: file.fileName,
      mime: file.mimeType,
      bytes: file.sizeBytes,
    }));
}

/** start/end 重放同一元数据时保持幂等；不修改原用户正文或图片引用。 */
export function withNekUserFiles(row: UserInputRow, files: AttachmentRef[]): UserInputRow {
  return {
    ...row,
    attachments: [
      ...(row.attachments ?? []).filter((attachment) => !attachment.ref.startsWith("nek-file:")),
      ...files,
    ],
  };
}

/** 授权来自指定会话的附件消息，不接受任意路径、工具输出或其它会话的引用。 */
export function findNekUserFile(
  sessionId: string,
  ref: string,
  entries: readonly NekSessionEntry[],
): NekStoredAttachment | undefined {
  if (!/^nek-file:[a-f0-9]{64}$/u.test(ref)) throw new Error("Unknown nek file attachment ref");
  for (const entry of entries) {
    if (entry.type !== "custom_message") continue;
    const files = readNekStoredAttachments(entry);
    const match = files?.find((file) => nekUserFileRef(sessionId, file) === ref);
    if (match) return match;
  }
  return undefined;
}
