import { CONVERSATION_ARCHIVE_CHUNK_BYTES, CONVERSATION_ARCHIVE_LIMITS } from "@zcode/shared";
import type { NekTaskArchiveRequest, NekTaskArchiveResult } from "@zcode/shared/nek-protocol";

/** File bytes only enter this operation's captured host attachment. */
export async function importConversationArchive(
  call: (request: NekTaskArchiveRequest) => Promise<NekTaskArchiveResult>,
  target: Pick<NekTaskArchiveRequest, "workspacePath" | "workspaceIdentity">,
  data: ArrayBuffer,
  assertCurrent: () => void,
  onCommit: () => void,
): Promise<string> {
  if (!data.byteLength) throw new Error("fault.taskArchive.invalidFile");
  if (data.byteLength > CONVERSATION_ARCHIVE_LIMITS.archiveBytes) {
    throw new Error("fault.taskArchive.limitExceeded");
  }
  assertCurrent();
  const begin = await call({ ...target, action: "beginImport", byteLength: data.byteLength });
  if (begin.action !== "beginImport") throw new Error("Invalid task archive transfer response");
  const transfer = { ...target, archiveId: begin.archiveId };
  try {
    const bytes = new Uint8Array(data);
    for (let offset = 0; offset < bytes.length; offset += CONVERSATION_ARCHIVE_CHUNK_BYTES) {
      assertCurrent();
      const chunk = bytes.subarray(offset, offset + CONVERSATION_ARCHIVE_CHUNK_BYTES);
      let binary = "";
      for (let start = 0; start < chunk.length; start += 8192) {
        binary += String.fromCharCode(...chunk.subarray(start, start + 8192));
      }
      const result = await call({
        ...transfer,
        action: "appendImport",
        offset,
        data: btoa(binary),
      });
      if (result.action !== "appendImport")
        throw new Error("Invalid task archive transfer response");
    }
    assertCurrent();
    onCommit();
    const result = await call({ ...transfer, action: "import" });
    if (result.action !== "import") throw new Error("Invalid task archive import response");
    return result.sessionId;
  } finally {
    await call({ ...transfer, action: "release" }).catch(() => undefined);
  }
}
