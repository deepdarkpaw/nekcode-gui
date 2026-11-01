import type { GitRepositorySummary } from "@zcode/shared";
import type {
  BackgroundWorkSummary,
  GoalState,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, it } from "vitest";
import { buildConversationStatusPanelModel } from "./conversationStatusPanelModel.js";

const GIT: GitRepositorySummary = {
  workspacePath: "/repo",
  repoRoot: "/repo",
  workspaceInRepoPath: "",
  autoRefreshWatchPaths: [],
  branchName: "feature",
  trackingBranchName: "origin/feature",
  headRefType: "branch",
  ahead: 2,
  behind: 1,
  isDirty: true,
  isGitAvailable: true,
  isRepository: true,
};

function plan(rowId: number, status: ToolCallRow["status"], markdown = "# Plan"): ToolCallRow {
  return {
    kind: "toolCall",
    rowId,
    toolCallId: `tool-${rowId}`,
    turnId: "turn",
    createdAt: 1,
    createdAtSeq: rowId,
    toolName: "ExitPlanMode",
    status,
    inputText: "",
    input: { plan: markdown, planFilePath: "plans/feature.md" },
  };
}

function work(
  workId: string,
  kind: BackgroundWorkSummary["kind"],
  status: BackgroundWorkSummary["status"],
): BackgroundWorkSummary {
  return { workId, kind, status, title: workId, startedAt: 1, anchorRowId: null };
}

describe("conversation status panel model", () => {
  it("has no content when all retained sections are empty", () => {
    expect(buildConversationStatusPanelModel({})).toEqual({
      hasContent: false,
      git: null,
      goal: null,
      sessionPlans: null,
      runningBashWorks: [],
    });
  });

  it("keeps git changes with their branch, totals, and ahead/behind counts", () => {
    const model = buildConversationStatusPanelModel({
      gitSummary: GIT,
      gitDirtyFileCount: 3,
      gitWorktreeChangeSummary: { added: 12, removed: 4 },
    });
    expect(model.hasContent).toBe(true);
    expect(model.git).toEqual({
      branchName: "feature",
      headRefType: "branch",
      dirtyFileCount: 3,
      added: 12,
      removed: 4,
      ahead: 2,
      behind: 1,
      isClean: false,
    });
  });

  it.each([
    { gitSummary: { ...GIT, isGitAvailable: false } },
    { gitSummary: { ...GIT, isRepository: false } },
    { gitSummary: GIT, isOfficeMode: true },
    { gitSummary: GIT, gitWorktreeChangeSummary: { added: 0, removed: 0 } },
  ])("does not show git without visible worktree changes or in office mode (%j)", (input) => {
    const model = buildConversationStatusPanelModel({
      gitWorktreeChangeSummary: { added: 12, removed: 4 },
      ...input,
    });
    expect(model.git).toBeNull();
    expect(model.hasContent).toBe(false);
  });

  it("preserves a goal as panel content independently of git or running work", () => {
    const goal: GoalState = {
      targetId: "target",
      objective: "Ship feature",
      summaryTitle: "Feature",
      timeUsedSeconds: 60,
      activeRunStartedAtMs: null,
      status: "paused",
      iteration: 2,
      verifications: [],
      iterations: [],
    };
    const model = buildConversationStatusPanelModel({ goal });
    expect(model.goal).toBe(goal);
    expect(model.hasContent).toBe(true);
  });

  it("keeps terminal-state session plan documents newest first, not todos or running plan calls", () => {
    const model = buildConversationStatusPanelModel({
      workspacePath: "/repo",
      sessionPlans: [
        plan(1, "success", "# First"),
        plan(2, "running"),
        plan(3, "inputStreaming"),
        plan(4, "error", "# Second"),
        plan(5, "cancelled", "# Third"),
        plan(6, "success", ""),
        { ...plan(7, "success"), toolName: "TodoWrite" },
      ],
    });
    expect(model.sessionPlans).toEqual({
      items: [
        {
          rowId: 5,
          toolCallId: "tool-5",
          markdown: "# Third",
          title: "Third",
          planFilePath: "/repo/plans/feature.md",
        },
        {
          rowId: 4,
          toolCallId: "tool-4",
          markdown: "# Second",
          title: "Second",
          planFilePath: "/repo/plans/feature.md",
        },
        {
          rowId: 1,
          toolCallId: "tool-1",
          markdown: "# First",
          title: "First",
          planFilePath: "/repo/plans/feature.md",
        },
      ],
    });
    expect(model.hasContent).toBe(true);
  });

  it("counts only running bash work as panel content", () => {
    const bash = work("bash", "bash", "running");
    const otherWorks = [
      work("agent", "subagent", "running"),
      work("completed", "bash", "resultPending"),
      work("failed", "bash", "failed"),
      work("cancelled", "bash", "cancelled"),
    ];
    expect(buildConversationStatusPanelModel({ backgroundWorks: otherWorks }).hasContent).toBe(
      false,
    );
    const model = buildConversationStatusPanelModel({ backgroundWorks: [bash, ...otherWorks] });
    expect(model.runningBashWorks).toEqual([bash]);
    expect(model.hasContent).toBe(true);
  });
});
