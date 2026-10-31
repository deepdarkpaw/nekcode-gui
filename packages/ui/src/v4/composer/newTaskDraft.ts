import type { ModelSelectionView } from "@zcode/services";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import { logger } from "@/logger.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";

/** 普通新任务与首次分享导入共用初始化；保留 Recent 原意图，由公共 View 解析有效选择。 */
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

/** 在激活首次导入的 Session 前调用；不依赖模型可执行，也不把原新任务正文带入分享。 */
export function seedImportedSessionDraft(result: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  reused: boolean;
}): void {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return;
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT);
  // 导入已创建真实 Session，旧初始化把空 snapshot 当成确定选择，跳过了新任务规则。
  // 显式标记首次导入来源，而非按“会话没模型”猜测；Root 的明确空选择也必须保留。
  persistV4ComposerDraft(
    workspacePath,
    workspaceIdentity,
    sessionId,
    root?.mode
      ? {
          text: "",
          mode: root.mode,
          planEnabled: root.planEnabled ?? false,
          modelSelection: root.modelSelection,
        }
      : { text: "", initializeFromNewTask: true },
  );
}
