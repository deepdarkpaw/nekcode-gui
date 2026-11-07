import type { GitRepositorySummary } from "@zcode/shared";
import type {
  BackgroundWorkSummary,
  GoalState,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { extractPlanToolCallContent, getPlanDirectoryTitle } from "@/lib/planToolCall.js";

export interface ConversationStatusPanelGitModel {
  branchName: string | null;
  headRefType: GitRepositorySummary["headRefType"];
  dirtyFileCount: number;
  added: number;
  removed: number;
  ahead: number;
  behind: number;
  isClean: boolean;
}

export interface ConversationStatusPanelSessionPlanItem {
  rowId: number;
  toolCallId: string;
  markdown: string;
  title?: string;
  planFilePath?: string;
}

export interface ConversationStatusPanelSessionPlansModel {
  items: ConversationStatusPanelSessionPlanItem[];
}

/**
 * 面板只承载 nek 状态槽没有的信息：git 改动、目标、计划文档、后台终端。
 * 待办与子代理由输入框上方的 nek 状态槽展示，这里不再重复。
 */
export interface ConversationStatusPanelModel {
  hasContent: boolean;
  git: ConversationStatusPanelGitModel | null;
  goal: GoalState | null;
  sessionPlans: ConversationStatusPanelSessionPlansModel | null;
  runningBashWorks: BackgroundWorkSummary[];
}

interface BuildConversationStatusPanelModelInput {
  isOfficeMode?: boolean;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  goal?: GoalState | null;
  sessionPlans?: readonly ToolCallRow[];
  workspacePath?: string;
  backgroundWorks?: readonly BackgroundWorkSummary[];
}

function buildGitModel({
  gitSummary,
  gitDirtyFileCount = 0,
  gitWorktreeChangeSummary,
}: Pick<
  BuildConversationStatusPanelModelInput,
  "gitSummary" | "gitDirtyFileCount" | "gitWorktreeChangeSummary"
>): ConversationStatusPanelGitModel | null {
  if (!gitSummary?.isGitAvailable || !gitSummary.isRepository) {
    return null;
  }
  const added = gitWorktreeChangeSummary?.added ?? 0;
  const removed = gitWorktreeChangeSummary?.removed ?? 0;
  // 只要 workspace 是 Git repository 就必须给出 Git model：环境分区的「更改」入口、
  // 分支切换与提交/推送菜单都挂在它上面。按行级变化决定有无会让 clean repo、
  // 未跟踪/二进制/重命名改动（行统计为 0）和待推送 commit（ahead > 0）直接丢掉整个分区。
  const isClean =
    !gitSummary.isDirty &&
    gitDirtyFileCount === 0 &&
    added === 0 &&
    removed === 0 &&
    gitSummary.ahead === 0;

  return {
    branchName: gitSummary.branchName,
    headRefType: gitSummary.headRefType,
    dirtyFileCount: gitDirtyFileCount,
    added,
    removed,
    ahead: gitSummary.ahead,
    behind: gitSummary.behind,
    isClean,
  };
}

function buildSessionPlansModel(
  rows: readonly ToolCallRow[] | undefined,
  workspacePath: string | undefined,
): ConversationStatusPanelSessionPlansModel | null {
  if (!rows?.length) return null;
  const items = rows
    .filter(
      (row) =>
        (row.toolName === "ExitPlanMode" || row.toolName === "nek.plan") &&
        (row.status === "success" || row.status === "error" || row.status === "cancelled"),
    )
    .toSorted((left, right) => right.rowId - left.rowId)
    .flatMap((row) => {
      const content = extractPlanToolCallContent(row, workspacePath ?? "");
      if (!content.markdown) return [];
      const title = getPlanDirectoryTitle(content.markdown);
      return [
        {
          rowId: row.rowId,
          toolCallId: row.toolCallId,
          markdown: content.markdown,
          ...(title ? { title } : {}),
          ...(content.planFilePath ? { planFilePath: content.planFilePath } : {}),
        },
      ];
    });
  return items.length > 0 ? { items } : null;
}

export function buildConversationStatusPanelModel(
  input: BuildConversationStatusPanelModelInput,
): ConversationStatusPanelModel {
  const git = input.isOfficeMode ? null : buildGitModel(input);
  const goal = input.goal ?? null;
  const sessionPlans = buildSessionPlansModel(input.sessionPlans, input.workspacePath);
  const runningBashWorks = (input.backgroundWorks ?? []).filter(
    (work) => work.status === "running" && work.kind === "bash",
  );

  return {
    git,
    goal,
    sessionPlans,
    runningBashWorks,
    hasContent: Boolean(git || goal || sessionPlans || runningBashWorks.length > 0),
  };
}
