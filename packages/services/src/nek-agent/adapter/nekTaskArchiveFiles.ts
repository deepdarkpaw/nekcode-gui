import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { CONVERSATION_ARCHIVE_CHUNK_BYTES, CONVERSATION_ARCHIVE_LIMITS } from "@zcode/shared";

/** Both commands receive a private file path assigned on the executing host. */
export async function withNekTaskArchiveFile<T>(
  root: string,
  run: (path: string) => Promise<T>,
  logger?: { warn: (...args: unknown[]) => void },
): Promise<T> {
  let directory: string | undefined;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(root, "task-"));
    return await run(join(directory, "archive.jsonl"));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["EACCES", "EPERM", "ENOSPC", "EROFS"].includes(String(error.code))
    ) {
      throw new Error("fault.taskArchive.permissionDenied", { cause: error });
    }
    throw error;
  } finally {
    // Never replace a committed import's ACK with a local cleanup error.
    if (directory) {
      await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(
        (error: NodeJS.ErrnoException) => {
          logger?.warn("nek task archive temporary file cleanup failed", { code: error.code });
        },
      );
    }
  }
}

/** Stat before allocating, and never read more data than the existing transfer budget. */
export async function readNekTaskArchiveFile(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0) throw new Error("fault.taskArchive.invalidFile");
    if (info.size > CONVERSATION_ARCHIVE_LIMITS.archiveBytes) {
      throw new Error("fault.taskArchive.limitExceeded");
    }
    const bytes = Buffer.allocUnsafe(info.size);
    for (let offset = 0; offset < bytes.length; ) {
      const result = await file.read(
        bytes,
        offset,
        Math.min(CONVERSATION_ARCHIVE_CHUNK_BYTES, bytes.length - offset),
        offset,
      );
      if (result.bytesRead === 0) throw new Error("fault.taskArchive.incompleteExport");
      offset += result.bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}

/**
 * Verify JSONL framing only. nek v0.5.1 (`core/session-entries.ts`) skips malformed lines, so
 * refuse broken framing rather than silently losing history. Entry/version/branch semantics
 * and migration belong entirely to `import_session`.
 */
export function checkNekTaskArchiveInput(bytes: Buffer): void {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let header = false;
  let hasMessage = false;
  try {
    for (let offset = 0; offset < bytes.length; ) {
      const newline = bytes.indexOf(10, offset);
      const end = newline === -1 ? bytes.length : newline;
      const line = decoder.decode(bytes.subarray(offset, end)).trim();
      offset = end + 1;
      if (!line) continue;
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || !("type" in parsed)) {
        throw new Error("Not a nek JSONL record");
      }
      if (!header) {
        if (parsed.type !== "session") throw new Error("Missing nek JSONL header");
        header = true;
      } else if (parsed.type === "message") {
        hasMessage = true;
      }
    }
  } catch {
    // Do not include a JSON.parse excerpt: it could contain original task data.
    throw new Error("fault.taskArchive.invalidFile");
  }
  if (!header || !hasMessage) throw new Error("fault.taskArchive.invalidFile");
}
