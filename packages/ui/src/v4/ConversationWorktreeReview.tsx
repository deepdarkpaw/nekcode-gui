import { useEffect, useMemo, useState } from "react";
import type { IGitService } from "@zcode/services";
import type { GitDiffResult, GitWorktreeReview } from "@zcode/shared";
import { FileDiffIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { IconButton } from "@/components/ui/icon-button.js";
import { Fold, FoldContent, FoldTrigger } from "@/components/ui/fold.js";
import { DiffViewer } from "@/components/ui/diff-viewer.js";
import { LightweightDiffPreview } from "@/components/ui/lightweight-diff-preview.js";
import { getDiffFallbackMessageId, getGitPaneDiffPreviewPlan } from "@/GitPane/helpers.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayInline } from "@/lib/fileDisplay.js";
import { logger } from "@/logger.js";
import { resolveTheme } from "@/useTheme.js";
import type { ConversationRowRenderContext } from "./conversationRowContext.js";

type ReviewService = Pick<IGitService, "getWorktreeReview" | "getDiff">;
type Resource<T> = { key: string; value?: T; error?: string };
const EMPTY_FILES: GitWorktreeReview["files"] = [];

/** One current-workspace review, never a duplicate live Git state attached to each historical turn. */
export function ConversationWorktreeReview({
  context,
  revision,
}: {
  context: ConversationRowRenderContext;
  revision: string;
}) {
  const { gitService } = useWorkspaceServices(
    context.workspacePath,
    context.workspaceRemoteSessionId,
    context.workspaceIdentity,
  );
  return (
    <WorktreeReviewPanel
      key={`${context.workspaceIdentity}:${context.workspacePath}:${revision}`}
      context={context}
      service={gitService}
    />
  );
}

export function WorktreeReviewPanel({
  context,
  service,
}: {
  context: ConversationRowRenderContext;
  service: ReviewService;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [visibleCount, setVisibleCount] = useState(20);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [reviewState, setReviewState] = useState<Resource<GitWorktreeReview> | null>(null);
  const [diffState, setDiffState] = useState<Resource<GitDiffResult> | null>(null);
  const key = `${context.workspaceIdentity}:${context.workspacePath}:${refresh}`;
  const diffKey = `${key}:${selectedPath}`;
  const review = reviewState?.key === key ? reviewState : null;
  const diff = diffState?.key === diffKey ? diffState : null;
  const t = (id: string) => intl.formatMessage({ id });

  useEffect(() => {
    let active = true;
    void service.getWorktreeReview({ workspacePath: context.workspacePath }).then(
      (value) => {
        if (active) setReviewState({ key, value });
      },
      (error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[WorktreeReview] failed to load Git review", { error: message });
        setReviewState({ key, error: message });
      },
    );
    return () => {
      active = false;
    };
  }, [context.workspacePath, key, service]);

  useEffect(() => {
    if (!open || !selectedPath) return;
    let active = true;
    void service
      .getDiff({ workspacePath: context.workspacePath, path: selectedPath, compareToHead: true })
      .then(
        (value) => {
          if (active) setDiffState({ key: diffKey, value });
        },
        (error: unknown) => {
          if (!active) return;
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("[WorktreeReview] failed to load net diff", { error: message });
          setDiffState({ key: diffKey, error: message });
        },
      );
    return () => {
      active = false;
    };
  }, [context.workspacePath, diffKey, open, selectedPath, service]);

  const files = review?.value?.files ?? EMPTY_FILES;
  const totals = useMemo(
    () =>
      files.reduce(
        (sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }),
        { added: 0, removed: 0 },
      ),
    [files],
  );
  const plan = useMemo(() => getGitPaneDiffPreviewPlan(diff?.value ?? null), [diff?.value]);
  const settings = context.codePreviewSettings;
  const status = review?.error
    ? review.error
    : !review
      ? t("common.loading")
      : !review.value?.isGitAvailable
        ? t("git.diffReview.gitUnavailable")
        : !review.value.isRepository
          ? t("git.diffReview.notRepository")
          : files.length === 0
            ? t("git.diffReview.clean")
            : null;

  return (
    <div data-worktree-review="true" className="py-5 text-ui-base">
      <Fold open={open} onOpenChange={setOpen}>
        <div className="flex items-center gap-2">
          <FoldTrigger className="min-w-0 flex-1 text-foreground-subtle">
            <FileDiffIcon className="size-4 shrink-0" />
            <span>{t("git.diffReview.title")}</span>
            {review?.value?.isRepository ? (
              <span>
                {intl.formatMessage({ id: "git.diffReview.files" }, { count: files.length })}
              </span>
            ) : null}
            {files.length > 0 ? (
              <>
                <span className="text-diff-added">+{totals.added}</span>
                <span className="text-diff-removed">-{totals.removed}</span>
              </>
            ) : null}
          </FoldTrigger>
          <IconButton
            size="icon-sm"
            label={t("git.diffReview.refresh")}
            disabled={!review}
            disabledReason={!review ? t("common.loading") : undefined}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCwIcon className="size-4" />
          </IconButton>
        </div>
        {status ? (
          <div
            role={review?.error ? "alert" : undefined}
            className="mt-2 text-ui-sm text-foreground-subtle"
          >
            {status}
          </div>
        ) : null}
        <FoldContent>
          <div className="space-y-2 pt-3">
            <p className="text-ui-sm text-foreground-subtlest">{t("git.diffReview.scope")}</p>
            {files.slice(0, visibleCount).map((file) => (
              <Fold
                key={file.path}
                open={selectedPath === file.path}
                onOpenChange={(next) => setSelectedPath(next ? file.path : null)}
              >
                <FoldTrigger className="w-full text-foreground-subtle">
                  <FileDisplayInline path={file.workspaceRelativePath} />
                  <span className="ml-auto text-diff-added">+{file.added}</span>
                  <span className="text-diff-removed">-{file.removed}</span>
                </FoldTrigger>
                <FoldContent>
                  {selectedPath === file.path ? (
                    <div className="max-h-96 overflow-auto pt-2">
                      {diff?.error ? (
                        <div role="alert">{diff.error}</div>
                      ) : !diff?.value ? (
                        <span>{t("common.loading")}</span>
                      ) : diff.value.availability !== "patch" ? (
                        <span>{t(getDiffFallbackMessageId(diff.value.availability))}</span>
                      ) : plan.kind === "plain-text" ? (
                        <LightweightDiffPreview lines={plan.lines} codePreviewSettings={settings} />
                      ) : diff.value.patch ? (
                        <DiffViewer
                          patch={diff.value.patch}
                          fontSizePx={settings.fontSizePx}
                          lightTheme={settings.lightTheme}
                          darkTheme={settings.darkTheme}
                          themeType={resolveTheme(context.theme)}
                        />
                      ) : (
                        <span>{t("git.diffReview.clean")}</span>
                      )}
                    </div>
                  ) : null}
                </FoldContent>
              </Fold>
            ))}
            {visibleCount < files.length ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setVisibleCount((count) => count + 20)}
              >
                {t("git.diffReview.more")}
              </Button>
            ) : null}
          </div>
        </FoldContent>
      </Fold>
    </div>
  );
}
