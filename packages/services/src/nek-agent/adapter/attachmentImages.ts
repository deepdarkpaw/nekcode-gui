import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { asRecord, readString } from "./frameHelpers.js";

const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

type NekImage = { type: "image"; data: string; mimeType: string };

/** 内联图片字节转换；普通文件走 attachmentInput 的执行端路径契约。 */
export async function toNekImages(attachments: unknown): Promise<NekImage[] | undefined> {
  if (attachments === undefined) return undefined;
  if (!Array.isArray(attachments)) throw new Error("附件列表格式不正确");
  const images: NekImage[] = [];
  for (const attachment of attachments) {
    const record = asRecord(attachment);
    if (!record) throw new Error("附件格式不正确");
    const mime = readString(record, "mime") ?? readString(record, "mimeType");
    if (!mime?.toLowerCase().startsWith("image/")) {
      throw new Error("文件附件缺少可读取路径；请重新添加文件");
    }
    const data =
      readString(record, "dataBase64") ??
      readString(record, "data") ??
      readString(record, "base64");
    if (data) {
      images.push({ type: "image", data, mimeType: mime });
      continue;
    }
    const path = readString(record, "localPath") ?? readString(record, "ref");
    if (!path || !isAbsolute(path)) {
      throw new Error("图片附件缺少可读取数据；请重新粘贴图片或使用 @路径引用文件");
    }
    const fileStat = await stat(path);
    if (fileStat.size > MAX_INLINE_IMAGE_BYTES) {
      throw new Error("图片附件超过 20 MB 限制；请压缩后重试");
    }
    const bytes = await readFile(path);
    images.push({ type: "image", data: bytes.toString("base64"), mimeType: mime });
  }
  return images;
}
