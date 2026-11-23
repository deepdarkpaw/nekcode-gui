import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CONVERSATION_ARCHIVE_LIMITS, type IPlatformService } from "@zcode/shared";
import type { TaskArchiveTarget } from "@/hooks/useConversationImport.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { dismissToast, toast, updateToast } from "@/components/ui/toast.js";
import { importConversationArchive } from "@/lib/importConversationArchive.js";
import { saveConversationExport } from "@/lib/saveConversationExport.js";
import { logger } from "@/logger.js";
import { captureTaskArchiveTarget, watchTaskArchiveTarget } from "./taskArchiveTarget.js";

type IntlShape = ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
type Operation = { kind: "import" } | { kind: "export"; taskId: string };
const EXPORT_DIALOG = "task-archive-export-confirmation";

function validateArchiveName(name: string): void {
  const lower = name.toLowerCase();
  if (lower.endsWith(".nekcode")) throw new Error("fault.taskArchive.legacyFile");
  if (!lower.endsWith(".jsonl")) throw new Error("fault.taskArchive.invalidFile");
}

function dismissExportConfirmation() {
  const dialog = useConfirmDialogStore.getState();
  if (dialog.pendingRequest?.testId === EXPORT_DIALOG) dialog.settleChoice("dismiss");
}

function failureId(error: unknown, operation: Operation, committing: boolean) {
  const message = error instanceof Error ? error.message : "";
  switch (message) {
    case "fault.taskArchive.invalidFile":
    case "fault.taskArchive.legacyFile":
    case "fault.taskArchive.limitExceeded":
    case "fault.taskArchive.importRejected":
    case "fault.taskArchive.importedButNotIndexed":
    case "fault.taskArchive.noTask":
    case "fault.taskArchive.permissionDenied":
    case "fault.taskArchive.taskLocked":
    case "fault.taskArchive.targetUnavailable":
    case "fault.taskArchive.targetChanged":
      return message.slice("fault.".length);
    case "fault.taskArchive.unavailable":
      return committing ? "taskArchive.importUnknown" : "taskArchive.targetUnavailable";
  }
  if (error && typeof error === "object" && "kind" in error) {
    if (error.kind === "limit_exceeded") return "taskArchive.limitExceeded";
    if (error.kind === "invalid_file") return "taskArchive.invalidFile";
  }
  if (committing) return "taskArchive.importUnknown";
  return operation.kind === "import" ? "taskArchive.importFailed" : "taskArchive.exportFailed";
}

/** One window owns file selection, confirmation, transfer and normal task navigation. */
export function useConversationArchiveImport({
  platform,
  intl,
  isDesktop,
}: {
  platform: IPlatformService;
  intl: IntlShape;
  isDesktop?: boolean;
}) {
  const base = useOptionalBaseWorkspaceServices();
  const tabs = useTabStoreApi();
  const hasWorkspace = useTabStore((state) =>
    state.tabs.some((tab) => tab.id === state.activeTabId && isWorkspaceTab(tab)),
  );
  const confirm = useConfirmDialog();
  const [busy, setBusy] = useState(false);
  const locking = useRef(false);
  const lifetime = useRef(0);
  const failureToast = useRef<number | null>(null);
  const available = Boolean(isDesktop && hasWorkspace && platform.selectFileData);
  const canExport = Boolean(isDesktop && hasWorkspace && platform.saveFile);
  useEffect(() => {
    return () => {
      lifetime.current++;
      if (failureToast.current !== null) dismissToast(failureToast.current);
      dismissExportConfirmation();
    };
  }, []);

  const start = useCallback(
    (operation: Operation, from?: TaskArchiveTarget, callerCurrent?: () => boolean): boolean => {
      if (locking.current || (operation.kind === "import" ? !available : !canExport)) return false;
      const msg = (id: string) => intl.formatMessage({ id });
      if (failureToast.current !== null) dismissToast(failureToast.current);
      let binding: ReturnType<typeof captureTaskArchiveTarget>;
      try {
        if (!base) throw new Error("fault.taskArchive.targetUnavailable");
        binding = captureTaskArchiveTarget(tabs, base, from);
      } catch {
        failureToast.current = toast(msg("taskArchive.targetUnavailable"), { variant: "warning" });
        return true;
      }
      locking.current = true;
      setBusy(true);
      const owner = lifetime.current;
      const watched = watchTaskArchiveTarget(tabs, base, binding, dismissExportConfirmation);
      const isCurrent = () =>
        lifetime.current === owner && watched.isCurrent() && (callerCurrent?.() ?? true);
      const assertCurrent = () => {
        if (!isCurrent()) throw new Error("fault.taskArchive.targetChanged");
      };
      const { service, workspacePath, workspaceIdentity } = binding;
      const target = { workspacePath, workspaceIdentity };
      const call: typeof service.nekTaskArchive = (request) => service.nekTaskArchive(request);
      let progress: number | undefined;
      let committing = false;
      const reportProgress = (id: string) => {
        if (progress === undefined) {
          progress = toast(msg(id), { variant: "info", durationMs: 0, dismissible: false });
        } else {
          updateToast(progress, { message: msg(id) });
        }
      };

      async function run() {
        try {
          assertCurrent();
          if (operation.kind === "export") {
            const approved = await confirm({
              title: msg("taskArchive.export"),
              description: msg("taskArchive.exportDisclosure"),
              confirmLabel: msg("taskArchive.exportContinue"),
              testId: EXPORT_DIALOG,
            });
            assertCurrent();
            if (!approved) return;
            reportProgress("taskArchive.exporting");
            const result = await call({ ...target, action: "export", sessionId: operation.taskId });
            if (result.action !== "export") throw new Error("Invalid native export response");
            const saved = await saveConversationExport(
              {
                readExportChunk: async (archiveId, offset) => {
                  const chunk = await call({ ...target, action: "readExport", archiveId, offset });
                  if (chunk.action !== "readExport") throw new Error("Invalid native export chunk");
                  return chunk.data;
                },
                releaseExport: (archiveId) => call({ ...target, action: "release", archiveId }),
              },
              platform,
              result.archive,
              assertCurrent,
            );
            if (!isCurrent() || saved.canceled) return;
            if (!saved.success) {
              throw new Error(
                saved.error === "write_failed"
                  ? "fault.taskArchive.permissionDenied"
                  : "Task archive was not saved",
              );
            }
            toast(msg(saved.downloadStarted ? "taskArchive.downloadStarted" : "taskArchive.saved"));
            return;
          }

          // Include .nekcode only so selecting a legacy file can give a targeted, non-destructive error.
          const file = await platform.selectFileData!({
            accept: ".jsonl,.nekcode",
            maxBytes: CONVERSATION_ARCHIVE_LIMITS.archiveBytes,
            validateName: validateArchiveName,
          });
          if (!file) return;
          assertCurrent();
          validateArchiveName(file.name);
          reportProgress("taskArchive.uploading");
          const sessionId = await importConversationArchive(
            call,
            target,
            file.data,
            assertCurrent,
            () => {
              committing = true;
              reportProgress("taskArchive.importing");
            },
          );
          if (lifetime.current !== owner) return;
          if (!isCurrent()) {
            toast(msg("taskArchive.importedElsewhere"), { variant: "info" });
            return;
          }
          // catalog_changed refreshes the normal sessions index; selecting this real nek task mounts the standard pane.
          useZCodeSessionStore
            .getState()
            .setActiveTaskId(workspacePath, sessionId, workspaceIdentity);
          toast(msg("taskArchive.imported"));
        } catch (error) {
          if (lifetime.current !== owner) return;
          const id = failureId(error, operation, committing);
          const retryable =
            isCurrent() &&
            [
              "taskArchive.importRejected",
              "taskArchive.permissionDenied",
              "taskArchive.importFailed",
              "taskArchive.exportFailed",
            ].includes(id);
          logger.warn("[task-archive] operation failed", { kind: operation.kind, id });
          failureToast.current = toast(msg(id), {
            variant: "warning",
            durationMs: 9000,
            dismissible: true,
            ...(retryable
              ? {
                  actionLabel: msg("taskArchive.retry"),
                  onAction: () => {
                    if (isCurrent()) start(operation, binding, callerCurrent);
                  },
                }
              : {}),
          });
        } finally {
          watched.dispose();
          if (progress !== undefined) dismissToast(progress);
          locking.current = false;
          if (lifetime.current === owner) setBusy(false);
        }
      }
      void run();
      return true;
    },
    [available, base, canExport, confirm, intl, platform, tabs],
  );

  return useMemo(
    () => ({
      available,
      canExport,
      busy,
      open: (from?: TaskArchiveTarget, isCurrent?: () => boolean) =>
        start({ kind: "import" }, from, isCurrent),
      exportTask: (from: TaskArchiveTarget, taskId: string, isCurrent?: () => boolean) =>
        start({ kind: "export", taskId }, from, isCurrent),
    }),
    [available, busy, canExport, start],
  );
}
