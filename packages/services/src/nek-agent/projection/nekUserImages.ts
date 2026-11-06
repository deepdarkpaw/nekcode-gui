import { createHash } from "node:crypto";
import type { NekImageContent, NekSessionEntry, NekUserMessage } from "@zcode/shared/nek-protocol";
import type { UserInputRow } from "@zcode/shared/zcode-protocol-v4";

interface NekUserImageLocator {
  timestamp: number;
  blockIndex: number;
}

/** 不依赖 live/entry 的行身份；会话身份和图片内容共同绑定 ref，重载后仍可重算。 */
export function nekUserImageRef(
  sessionId: string,
  timestamp: number,
  blockIndex: number,
  image: NekImageContent,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([sessionId, timestamp, blockIndex, image.mimeType]))
    .update(image.data)
    .digest("hex");
  return `nek-image:${timestamp}:${blockIndex}:${digest}`;
}

/** 从 ref 提取查找线索；授权仍需用会话内原始图片重算完整 ref。 */
export function parseNekUserImageRef(ref: string): NekUserImageLocator {
  const match = /^nek-image:([^:]+):(\d+):[a-f0-9]{64}$/.exec(ref);
  const timestamp = Number(match?.[1]);
  const blockIndex = Number(match?.[2]);
  if (!match || !Number.isFinite(timestamp) || !Number.isSafeInteger(blockIndex))
    throw new Error("Unknown nek image attachment ref");
  return { timestamp, blockIndex };
}

/** nek 图片是标准 base64；只计算长度，不为投影分配整张图片的解码副本。 */
export function nekImageByteLength(image: NekImageContent): number {
  const { data, mimeType } = image;
  if (!mimeType.startsWith("image/")) throw new Error("Invalid nek image MIME type");
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new Error("Invalid nek image base64");
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/x-icon": "ico",
  "image/heic": "heic",
  "image/heif": "heif",
};

/** 原内容块序号用于 ref，图片序号仅用于可读文件名；不保留 base64。 */
export function projectNekUserImages(
  sessionId: string,
  message: NekUserMessage,
): NonNullable<UserInputRow["attachments"]> {
  if (typeof message.content === "string") return [];
  const attachments: NonNullable<UserInputRow["attachments"]> = [];
  message.content.forEach((block, blockIndex) => {
    if (block.type !== "image") return;
    const extension = IMAGE_EXTENSIONS[block.mimeType] ?? "img";
    attachments.push({
      ref: nekUserImageRef(sessionId, message.timestamp, blockIndex, block),
      fileName: `image-${attachments.length + 1}.${extension}`,
      mime: block.mimeType,
      bytes: nekImageByteLength(block),
    });
  });
  return attachments;
}

/** 只接受指定会话中用户消息的原始图片块，不允许 ref 指向任意路径或工具图片。 */
export function findNekUserImage(
  sessionId: string,
  ref: string,
  locator: NekUserImageLocator,
  entries: readonly NekSessionEntry[],
): NekImageContent | undefined {
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const message = entry.message;
    if (message.timestamp !== locator.timestamp || typeof message.content === "string") continue;
    const block = message.content[locator.blockIndex];
    if (
      block?.type === "image" &&
      nekUserImageRef(sessionId, message.timestamp, locator.blockIndex, block) === ref
    )
      return block;
  }
  return undefined;
}
