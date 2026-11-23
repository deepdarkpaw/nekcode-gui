import type { ModelSelectionView } from "@zcode/services";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import { logger } from "@/logger.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";

/** 初始化新任务；保留 Recent 原意图，由公共 View 解析有效选择。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity);
  const initial = resolveDraftInitialModelSelection(view, null);
  if (!recent?.modelSelection && !initial.selection && view.preferredSelectionIssue) {
    // 配置里的显式默认模型不可用：不静默换服务商，让 Composer 的空选择（“选择模型”）
    // 成为用户重选的入口；原因留在日志里，便于支持排查。
    logger.info("[v4-draft-config] 配置的默认模型不可用，等待用户重新选择", {
      issue: view.preferredSelectionIssue,
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? null,
    });
  }
  return {
    ...draft,
    initializeFromNewTask: undefined,
    mode: recent?.mode === "plan" ? "agent" : (recent?.mode ?? "agent"),
    planEnabled: false,
    modelSelection: recent?.modelSelection ?? initial.selection ?? undefined,
  };
}
