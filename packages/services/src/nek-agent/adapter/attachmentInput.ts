import { isAbsolute } from "node:path";
import {
  NEK_PROMPT_ATTACHMENT_LIMITS,
  type NekImageContent,
  type NekPromptAttachment,
} from "@zcode/shared/nek-protocol";
import type { NekAgentService } from "../service/nekAgentService.js";
import { toNekImages } from "./attachmentImages.js";
import { asRecord, readString } from "./frameHelpers.js";

/** 所有发送入口共用：只转换附件描述，快照、类型识别和内容读取均由 nek 接纳。 */
export async function toNekPromptAttachments(
  service: NekAgentService,
  sessionKey: string,
  value: unknown,
): Promise<{ attachments?: NekPromptAttachment[]; images?: NekImageContent[] }> {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.length > NEK_PROMPT_ATTACHMENT_LIMITS.maxCount)
    throw new Error("附件列表格式不正确或超过 8 个附件");
  const attachments: NekPromptAttachment[] = [];
  const images: NekImageContent[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) throw new Error("附件格式不正确");
    const ref = readString(record, "localPath") ?? readString(record, "ref");
    if (ref?.startsWith("nek-image:")) {
      images.push(await service.readUserImage(sessionKey, ref));
      continue;
    }
    if (ref?.startsWith("nek-file:")) {
      const file = await service.readUserFile(sessionKey, ref);
      if (file.mimeType.toLowerCase().startsWith("image/"))
        images.push(...((await toNekImages([{ ref: file.path, mime: file.mimeType }])) ?? []));
      else attachments.push({ path: file.path, fileName: file.fileName, mimeType: file.mimeType });
      continue;
    }
    if (ref) {
      if (!isAbsolute(ref)) throw new Error("附件路径必须是 nek 所在机器的绝对路径");
      const fileName = readString(record, "fileName") ?? readString(record, "filename");
      const mimeType = readString(record, "mime") ?? readString(record, "mimeType");
      /** 图片始终用既有 images 契约；普通文件路径能力不能拦住原本支持的粘贴/上传图片。 */
      if (mimeType?.toLowerCase().startsWith("image/")) {
        images.push(...((await toNekImages([item])) ?? []));
        continue;
      }
      attachments.push({
        path: ref,
        ...(fileName ? { fileName } : {}),
        ...(mimeType ? { mimeType } : {}),
      });
      continue;
    }
    // 旧调用方可直接提供图片字节；普通文件必须先经上传事务落到执行端。
    images.push(...((await toNekImages([item])) ?? []));
  }
  return {
    ...(attachments.length ? { attachments } : {}),
    ...(images.length ? { images } : {}),
  };
}
