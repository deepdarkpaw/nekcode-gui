// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitDiffResult, GitWorktreeReview } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { WorktreeReviewPanel } from "./ConversationWorktreeReview.js";
import { buildAssistantWorkRenderItems } from "./conversationAssistantWorkItems.js";
import type { ToolCallRow } from "@zcode/shared/zcode-protocol-v4";

vi.mock("@/components/ui/diff-viewer.js", () => ({
  DiffViewer: ({ patch }: { patch: string }) => <pre data-testid="net-diff">{patch}</pre>,
}));
const context = {
  workspacePath: "G:/project",
  workspaceIdentity: "local",
  theme: "light" as const,
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
};
const result: GitWorktreeReview = {
  isGitAvailable: true,
  isRepository: true,
  files: [
    { path: "G:/project/a.ts", workspaceRelativePath: "a.ts", added: 10, removed: 1 },
    { path: "G:/project/b.ts", workspaceRelativePath: "b.ts", added: 2, removed: 0 },
  ],
};
const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-original\n+final\n";
const diff: GitDiffResult = {
  path: "G:/project/a.ts",
  availability: "patch",
  patch,
  beforeContent: null,
  afterContent: null,
};
function service() {
  return { getWorktreeReview: vi.fn(async () => result), getDiff: vi.fn(async () => diff) };
}
function view(api: ReturnType<typeof service>, workspaceIdentity = "local") {
  return (
    <ZCodeIntlProvider initialLocale="en-US">
      <TooltipProvider>
        <WorktreeReviewPanel context={{ ...context, workspaceIdentity }} service={api} />
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}
afterEach(cleanup);

it("renders one net summary and fetches only the selected file's combined HEAD diff", async () => {
  const api = service();
  render(view(api));
  await screen.findByText("+12");
  expect(screen.getAllByText("Workspace Git diff")).toHaveLength(1);
  expect(api.getDiff).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Workspace Git diff"));
  await screen.findByText("a.ts");
  expect(screen.getAllByText("a.ts")).toHaveLength(1);
  fireEvent.click(screen.getByText("a.ts"));
  await screen.findByTestId("net-diff");
  expect(api.getDiff).toHaveBeenCalledWith({
    workspacePath: "G:/project",
    path: "G:/project/a.ts",
    compareToHead: true,
  });
  expect(screen.getByTestId("net-diff").textContent).toBe(patch);
  expect(screen.getByText(/Current workspace versus HEAD/)).toBeTruthy();
});

it("shows read errors and retries instead of silently showing no changes", async () => {
  const api = service();
  api.getWorktreeReview.mockRejectedValueOnce(new Error("Git failed"));
  render(view(api));
  expect((await screen.findByRole("alert")).textContent).toBe("Git failed");
  fireEvent.click(screen.getByRole("button", { name: "Refresh Git diff / Retry" }));
  await screen.findByText("+12");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not accept an old workspace's late response", async () => {
  const api = service();
  let finish!: (value: GitWorktreeReview) => void;
  api.getWorktreeReview.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const ui = render(view(api));
  ui.rerender(view(api, "remote"));
  await screen.findByText("+12");
  finish({ ...result, files: [] });
  await waitFor(() => expect(screen.getByText("+12")).toBeTruthy());
  expect(screen.queryByText("No uncommitted file changes.")).toBeNull();
});

it("hides successful write/edit history regardless of interleaving, but keeps failures and running calls visible", () => {
  const call = (rowId: number, toolName: string, status: ToolCallRow["status"]): ToolCallRow => ({
    rowId,
    turnId: "turn",
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName,
    status,
    createdAt: rowId,
    createdAtSeq: rowId,
    inputText: "",
    input: { path: "a.ts" },
  });
  const rows = [
    call(1, "edit", "success"),
    call(2, "read", "success"),
    call(3, "write", "success"),
    call(4, "edit", "error"),
    call(5, "write", "running"),
  ];
  const items = buildAssistantWorkRenderItems(
    rows,
    { messageStreamShowReasoning: true },
    { hideSuccessfulFileWrites: true },
  );
  expect(items.map((item) => (item.kind === "row" ? item.row.rowId : null))).toEqual([2, 4, 5]);
  expect(rows).toHaveLength(5);
});
