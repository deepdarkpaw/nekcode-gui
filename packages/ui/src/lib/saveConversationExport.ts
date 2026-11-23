import {
  CONVERSATION_ARCHIVE_CHUNK_BYTES,
  CONVERSATION_ARCHIVE_LIMITS,
  type ConversationArchiveExport,
  type IPlatformService,
  type SaveFileResult,
} from "@zcode/shared";

/** Read the bounded host transfer, release its handle, then hand it to the local save dialog. */
export async function saveConversationExport(
  service: {
    readExportChunk: (archiveId: string, offset: number) => Promise<string>;
    releaseExport: (archiveId: string) => Promise<unknown>;
  },
  platform: Pick<IPlatformService, "saveFile">,
  archive: ConversationArchiveExport,
  assertCurrent?: () => void,
): Promise<SaveFileResult> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    assertCurrent?.();
    if (
      !platform.saveFile ||
      !Number.isSafeInteger(archive.byteLength) ||
      archive.byteLength <= 0 ||
      archive.byteLength > CONVERSATION_ARCHIVE_LIMITS.archiveBytes
    ) {
      throw new Error("Conversation export cannot be saved");
    }
    bytes = new Uint8Array(archive.byteLength);
    for (let offset = 0; offset < bytes.length; ) {
      assertCurrent?.();
      const encoded = await service.readExportChunk(archive.archiveId, offset);
      const expected = Math.min(CONVERSATION_ARCHIVE_CHUNK_BYTES, bytes.length - offset);
      if (encoded.length !== Math.ceil(expected / 3) * 4)
        throw new Error("Invalid conversation export chunk");
      const chunk = atob(encoded);
      if (chunk.length !== expected) throw new Error("Incomplete conversation export");
      for (let i = 0; i < chunk.length; i++) bytes[offset + i] = chunk.charCodeAt(i);
      offset += chunk.length;
    }
  } finally {
    // 断连时 Host 的连接关闭/闲置期限负责回收；释放不改变对操作结果的判断。
    await service.releaseExport(archive.archiveId).catch(() => undefined);
  }
  assertCurrent?.();
  if (!platform.saveFile) throw new Error("Task export cannot be saved");
  return await platform.saveFile({ data: bytes.buffer, suggestedName: archive.suggestedName });
}
