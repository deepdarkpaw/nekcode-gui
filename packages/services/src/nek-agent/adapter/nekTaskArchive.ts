import { stat, writeFile } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { CONVERSATION_ARCHIVE_LIMITS } from "@zcode/shared";
import {
  nekTaskArchiveRequestSchema,
  type NekTaskArchiveRequest,
  type NekTaskArchiveResult,
} from "@zcode/shared/nek-protocol";
import { ConversationArchiveExports } from "../../conversation-share/conversationArchiveExports.js";
import { ConversationArchiveImports } from "../../conversation-share/conversationArchiveImports.js";
import { readTrustedZCodeAgentV4Connection } from "../../zcode-agent/zcodeAgentConnectionScope.js";
import { NekRpcCommandError } from "../nekRpcErrors.js";
import type { NekAgentService } from "../service/nekAgentService.js";
import { isListedNekSession } from "./nekSessionListing.js";
import {
  checkNekTaskArchiveInput,
  readNekTaskArchiveFile,
  withNekTaskArchiveFile,
} from "./nekTaskArchiveFiles.js";
import type { NekSessionBinding, NekWorkspaceTarget } from "./types.js";

interface Ports {
  service: Pick<
    NekAgentService,
    "exportSession" | "importSession" | "listSessions" | "getSession" | "conversationSnapshot"
  >;
  ensureBinding: (target: NekWorkspaceTarget, sessionId: string) => Promise<NekSessionBinding>;
  stagingDir: string;
  logger?: { warn: (...args: unknown[]) => void };
}

function ownerPrefix(connectionId: string): string {
  return `${JSON.stringify(connectionId)}\0`;
}

function ownerKey(target: NekWorkspaceTarget, connectionId: string): string {
  return (
    ownerPrefix(connectionId) +
    JSON.stringify([target.workspacePath, target.workspaceIdentity ?? ""])
  );
}

function samePath(left: string, right: string): boolean {
  const a = normalize(left);
  const b = normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Connection-scoped, bounded native archive I/O. The target CLI owns every saved entry. */
export function createNekTaskArchive(ports: Ports) {
  const exports = new ConversationArchiveExports();
  const imports = new ConversationArchiveImports();
  let disposed = false;

  async function importArchive(
    cwd: string,
    bytes: Buffer,
    assertCurrent: () => void,
  ): Promise<NekTaskArchiveResult> {
    checkNekTaskArchiveInput(bytes);
    if (!(await stat(cwd)).isDirectory()) throw new Error("fault.taskArchive.targetUnavailable");
    return await withNekTaskArchiveFile(
      ports.stagingDir,
      async (inputPath) => {
        await writeFile(inputPath, bytes, { flag: "wx", mode: 0o600 });
        assertCurrent();
        let sessionPath: string;
        try {
          ({ sessionPath } = await ports.service.importSession({ inputPath, cwd }));
        } catch (error) {
          if (error instanceof NekRpcCommandError) {
            throw new Error("fault.taskArchive.importRejected", { cause: error });
          }
          // Not every transport failure proves that the CLI did not create a task. Do not replay.
          throw new Error("fault.taskArchive.importUnknown", { cause: error });
        }
        assertCurrent();
        try {
          // New identity comes from the normal CLI catalog, never the filename or the original header.
          const task = (await ports.service.listSessions({ cwd })).find(
            (item) => samePath(item.path, sessionPath) && isListedNekSession(item),
          );
          if (!task) throw new Error("Imported task is not in the nek catalog");
          return { action: "import", sessionId: task.id };
        } catch (error) {
          throw new Error("fault.taskArchive.importedButNotIndexed", { cause: error });
        }
      },
      ports.logger,
    );
  }

  return {
    async run(input: NekTaskArchiveRequest): Promise<NekTaskArchiveResult> {
      const connection = readTrustedZCodeAgentV4Connection(input);
      if (disposed || connection?.clientMode !== "desktop-continuous") {
        throw new Error("fault.taskArchive.unavailable");
      }
      if (
        input.action === "beginImport" &&
        input.byteLength > CONVERSATION_ARCHIVE_LIMITS.archiveBytes
      ) {
        throw new Error("fault.taskArchive.limitExceeded");
      }
      const request = nekTaskArchiveRequestSchema.parse(input);
      if (!isAbsolute(request.workspacePath))
        throw new Error("fault.taskArchive.targetUnavailable");
      const owner = ownerKey(request, connection.connectionId);
      switch (request.action) {
        case "export": {
          let title = "";
          const archive = await exports.create(
            owner,
            () => title,
            async (assertCurrent) => {
              const { sessionKey } = await ports.ensureBinding(request, request.sessionId);
              const session = ports.service.getSession(sessionKey);
              if (session?.readonly) throw new Error("fault.taskArchive.taskLocked");
              const snapshot = ports.service.conversationSnapshot(sessionKey);
              if (!snapshot.rows.totalCount) throw new Error("fault.taskArchive.noTask");
              title = snapshot.meta.title ?? "";
              return await withNekTaskArchiveFile(
                ports.stagingDir,
                async (outputPath) => {
                  assertCurrent();
                  const result = await ports.service.exportSession({
                    sessionKey,
                    format: "jsonl",
                    outputPath,
                  });
                  // Read only our assigned output path; never trust an arbitrary path in the response.
                  if (!samePath(outputPath, result.path))
                    throw new Error("fault.taskArchive.invalidExportPath");
                  assertCurrent();
                  return await readNekTaskArchiveFile(outputPath);
                },
                ports.logger,
              );
            },
            "jsonl",
          );
          return { action: "export", archive };
        }
        case "readExport":
          return {
            action: "readExport",
            data: exports.read(owner, request.archiveId, request.offset),
          };
        case "beginImport":
          return { action: "beginImport", archiveId: imports.begin(owner, request.byteLength) };
        case "appendImport":
          imports.append(owner, request.archiveId, request.offset, request.data);
          return { action: "appendImport" };
        case "import":
          return await imports.consume(owner, request.archiveId, (bytes, assertCurrent) =>
            importArchive(request.workspacePath, bytes, assertCurrent),
          );
        case "release":
          exports.release(owner, request.archiveId);
          imports.release(owner, request.archiveId);
          return { action: "release" };
      }
    },
    closeConnection(connectionId: string): void {
      const prefix = ownerPrefix(connectionId);
      const matches = (owner: symbol | string) =>
        typeof owner === "string" && owner.startsWith(prefix);
      exports.closeOwners(matches);
      imports.closeOwners(matches);
    },
    dispose(): void {
      disposed = true;
      exports.closeOwners();
      imports.closeOwners();
    },
  };
}
