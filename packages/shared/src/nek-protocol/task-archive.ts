import { z } from "zod";
import {
  CONVERSATION_ARCHIVE_CHUNK_BYTES,
  CONVERSATION_ARCHIVE_LIMITS,
  type ConversationArchiveExport,
} from "../conversation-archive.js";

const target = z.object({
  workspacePath: z.string().min(1).max(4096),
  workspaceIdentity: z.string().max(4096).optional(),
});
const transfer = target.extend({ archiveId: z.uuid() });

/** Opaque connection/target-owned archive transfers; no client-supplied host file paths. */
export const nekTaskArchiveRequestSchema = z.discriminatedUnion("action", [
  target.extend({ action: z.literal("export"), sessionId: z.string().min(1).max(128) }),
  target.extend({
    action: z.literal("beginImport"),
    byteLength: z.number().int().min(1).max(CONVERSATION_ARCHIVE_LIMITS.archiveBytes),
  }),
  transfer.extend({
    action: z.literal("appendImport"),
    offset: z
      .number()
      .int()
      .min(0)
      .max(CONVERSATION_ARCHIVE_LIMITS.archiveBytes - 1),
    data: z.string().max(Math.ceil(CONVERSATION_ARCHIVE_CHUNK_BYTES / 3) * 4),
  }),
  transfer.extend({ action: z.literal("import") }),
  transfer.extend({
    action: z.literal("readExport"),
    offset: z
      .number()
      .int()
      .min(0)
      .max(CONVERSATION_ARCHIVE_LIMITS.archiveBytes - 1),
  }),
  transfer.extend({ action: z.literal("release") }),
]);
export type NekTaskArchiveRequest = z.infer<typeof nekTaskArchiveRequestSchema>;

export type NekTaskArchiveResult =
  | { action: "export"; archive: ConversationArchiveExport }
  | { action: "readExport"; data: string }
  | { action: "beginImport"; archiveId: string }
  | { action: "import"; sessionId: string }
  | { action: "appendImport" }
  | { action: "release" };
