import { stat } from "node:fs/promises";
import { Emitter } from "@zcode/rpc";
import { NEK_PROMPT_ATTACHMENT_LIMITS } from "@zcode/shared/nek-protocol";
import type { IRemoteBackend } from "@zcode/server/remote";
import type {
  IPromptAttachmentTransferService,
  PromptAttachmentStageResult,
  PromptAttachmentTransferProgress,
} from "@zcode/services";
import type { ZCodePromptAttachment } from "@zcode/shared";
import {
  cleanupRemotePromptAttachment,
  cleanupStaleRemotePromptAttachments,
  materializeRemotePromptAttachments,
} from "./remotePromptAttachments.js";

interface TransferRecord {
  controller: AbortController;
  ref?: string;
  bytes: number;
  adopted: boolean;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * 远程 workspace 的 eager staging 实现。记录只存在当前 workspace host，
 * relay/main 不持有附件进度或暂存生命周期。
 */
export function createRemotePromptAttachmentTransferService(
  backend: Pick<IRemoteBackend, "exec" | "upload">,
  options: {
    onJanitorError?: (error: unknown) => void;
    statLocalFile?: (path: string) => Promise<{ size: number; isFile(): boolean }>;
  } = {},
): IPromptAttachmentTransferService {
  const records = new Map<string, TransferRecord>();
  const emitters = new Map<string, Emitter<PromptAttachmentTransferProgress>>();

  void cleanupStaleRemotePromptAttachments(backend).catch((error) => {
    options.onJanitorError?.(error);
  });

  const getEmitter = (operationId: string) => {
    const existing = emitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<PromptAttachmentTransferProgress>({
      onDidRemoveLastListener: () => {
        emitters.delete(operationId);
        emitter.dispose();
      },
    });
    emitters.set(operationId, emitter);
    return emitter;
  };

  const cleanup = async (operationId: string, includeAdopted: boolean) => {
    const record = records.get(operationId);
    if (!record) return;
    record.controller.abort();
    if (record.ref && (includeAdopted || !record.adopted)) {
      await cleanupRemotePromptAttachment(backend, record.ref);
    }
    if (records.get(operationId) === record) records.delete(operationId);
  };

  return {
    async stage(params): Promise<PromptAttachmentStageResult> {
      const previous = records.get(params.operationId);
      previous?.controller.abort();
      const maxBytes = params.mime.toLowerCase().startsWith("image/")
        ? NEK_PROMPT_ATTACHMENT_LIMITS.maxImageBytes
        : NEK_PROMPT_ATTACHMENT_LIMITS.maxFileBytes;
      const controller = new AbortController();
      const record: TransferRecord = {
        controller,
        bytes: 0,
        adopted: false,
      };
      records.set(params.operationId, record);
      const emitter = getEmitter(params.operationId);
      let lastPercent = -1;
      let lastEmittedAt = 0;
      let lastUploadedBytes = 0;
      const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
      try {
        if (previous?.ref && !previous.adopted)
          await cleanupRemotePromptAttachment(backend, previous.ref);
        const fileStat = await (options.statLocalFile ?? stat)(params.localPath);
        if (records.get(params.operationId) !== record || controller.signal.aborted)
          throw Object.assign(new Error("Remote upload canceled"), { name: "AbortError" });
        if (!fileStat.isFile()) throw new Error("附件路径不是普通文件");
        if (fileStat.size > maxBytes)
          throw new Error(`附件超过 ${maxBytes / 1024 / 1024} MB 限制；请缩小后重试`);
        record.bytes = fileStat.size;
        const attachment: ZCodePromptAttachment = {
          kind: params.mime.startsWith("image/") ? "image" : "file",
          filename: params.fileName,
          localPath: params.localPath,
          mimeType: params.mime,
          sizeBytes: fileStat.size,
        } as ZCodePromptAttachment;
        const materialized = await materializeRemotePromptAttachments(
          {
            taskId: params.sessionId,
            // 暂存目录同时带 workspace identity 与 remote session 维度，避免同一路径、
            // 不同远端身份或 attached session 的 eager attachment 互相覆盖。
            traceId: `${workspaceKey}\u0000${params.remoteSessionId ?? ""}\u0000${params.operationId}`,
            content: "",
            attachments: [attachment],
          },
          {
            backend,
            uploadOptions: {
              signal: controller.signal,
              onProgress(progress) {
                if (progress.uploadedBytes > maxBytes || progress.totalBytes > maxBytes)
                  controller.abort();
                const totalBytes = Math.max(progress.totalBytes, record.bytes);
                record.bytes = totalBytes;
                lastUploadedBytes = Math.max(lastUploadedBytes, progress.uploadedBytes);
                const percent =
                  totalBytes > 0 ? Math.floor((lastUploadedBytes / totalBytes) * 100) : 0;
                const now = Date.now();
                if (percent <= lastPercent && now - lastEmittedAt < 100) return;
                lastPercent = Math.max(lastPercent, percent);
                lastEmittedAt = now;
                emitter.fire({
                  operationId: params.operationId,
                  phase: "uploading",
                  uploadedBytes: lastUploadedBytes,
                  totalBytes,
                });
              },
            },
          },
        );
        const next = materialized.attachments?.[0];
        const ref = next?.localPath?.trim();
        if (!ref) throw new Error("Remote attachment staging returned no path");
        if (records.get(params.operationId) !== record || controller.signal.aborted) {
          await cleanupRemotePromptAttachment(backend, ref);
          throw Object.assign(new Error("Remote upload canceled"), { name: "AbortError" });
        }
        record.ref = ref;
        emitter.fire({
          operationId: params.operationId,
          phase: "committing",
          uploadedBytes: record.bytes,
          totalBytes: record.bytes,
        });
        emitter.fire({
          operationId: params.operationId,
          phase: "complete",
          uploadedBytes: record.bytes,
          totalBytes: record.bytes,
        });
        return {
          operationId: params.operationId,
          ref,
          bytes: record.bytes,
          staged: true,
        };
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          emitter.fire({
            operationId: params.operationId,
            phase: "canceled",
            uploadedBytes: 0,
            totalBytes: record.bytes,
          });
        }
        if (records.get(params.operationId) === record) {
          records.delete(params.operationId);
        }
        throw error;
      }
    },
    async adopt(operationId) {
      const record = records.get(operationId);
      if (record?.ref) {
        // adopt 只在 nek 接纳后调用：稳定副本已由执行端拥有，SSH 暂存不再承担会话存储。
        await cleanupRemotePromptAttachment(backend, record.ref);
        record.adopted = true;
        if (records.get(operationId) === record) records.delete(operationId);
      }
    },
    async cancel(operationId) {
      await cleanup(operationId, false);
    },
    async cleanup(operationId) {
      await cleanup(operationId, false);
    },
    onDynamicProgress: (operationId) => getEmitter(operationId).event,
  };
}
