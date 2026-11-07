import { FileDiffIcon } from "lucide-react";
import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import { WorkspaceTerminalToggleButton } from "@/WorkspaceTerminalToggleButton.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { ConversationShareMenu } from "@/ConversationShareMenu.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";

export type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";

export function WorkspaceHeaderActionSection({
  variant = "task",
  activeTaskId,
  readOnlyReason,
  workspaceAbsPath,
  workspaceIdentity,
  remoteTarget,
  isDesktop,
  isTerminalOpen,
  isSidePaneOpen,
  onToggleTerminal,
  onToggleSidePane,
  toggleSidePaneShortcutLabel,
  isGitOpen = false,
  onToggleGit,
  showGitButton = false,
  onSelectedEditorChange,
  simplifyForNarrowRemote = false,
  hideHelpMenu = false,
  showWindowControls = false,
  useWindowsCaptionSpacing = false,
}: WorkspaceHeaderActionSectionProps) {
  const { intl } = useZCodeIntl();
  const gitLabel = intl.formatMessage({ id: "sidePane.review" });

  return (
    <div
      className={cn(
        "flex shrink-0 items-center [app-region:no-drag]",
        // Windows header 内容区有 p-2，普通工具栏按钮 hover 只覆盖 32px 高度。
        // 标题栏按钮需要抵消这层垂直内边距，和原生窗控/右侧菜单保持同一个 48px hover 面。
        useWindowsCaptionSpacing ? "-my-2 h-12 gap-0" : "gap-0.5",
      )}
    >
      {variant === "task" ? (
        <WorkspaceEditorButtonGroup
          disabledReason={readOnlyReason}
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          remoteTarget={remoteTarget}
          onSelectedEditorChange={onSelectedEditorChange}
        />
      ) : null}
      {/* 导出已由本地会话负责；旧账号门禁会让自配模型用户找不到导出入口。 */}
      {activeTaskId && isDesktop !== false ? (
        <ConversationShareMenu
          taskId={activeTaskId}
          useWindowsCaptionSpacing={useWindowsCaptionSpacing}
        />
      ) : null}
      {!simplifyForNarrowRemote ? (
        <>
          {!hideHelpMenu ? <WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} /> : null}
          {/* 远程控制移动端头部空间过窄，终端入口在这里会和核心操作争抢宽度。*/}
          <WorkspaceTerminalToggleButton
            isTerminalOpen={isTerminalOpen}
            onToggleTerminal={onToggleTerminal}
            disabledReason={readOnlyReason}
            useWindowsCaptionSpacing={useWindowsCaptionSpacing}
          />
          {/* 草稿页与窄屏没有右侧状态卡，Git 改动树只能从这里一键打开。 */}
          {showGitButton && onToggleGit ? (
            <ControlHintTooltip title={readOnlyReason ?? gitLabel} side="bottom">
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                className={cn(
                  "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
                  useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
                  isGitOpen && "!bg-selected text-foreground",
                )}
                aria-label={gitLabel}
                aria-pressed={isGitOpen}
                disabled={Boolean(readOnlyReason)}
                onClick={() => onToggleGit()}
              >
                <FileDiffIcon className="size-4" />
              </Button>
            </ControlHintTooltip>
          ) : null}
        </>
      ) : null}
      {/* 远程控制移动端只保留图标，避免 diff 数字把按钮撑宽导致标题拥挤。 */}
      {!isSidePaneOpen ? (
        <WorkspaceSidePaneToggleButton
          isSidePaneOpen={isSidePaneOpen}
          onToggleSidePane={onToggleSidePane}
          shortcutLabel={toggleSidePaneShortcutLabel}
          useWindowsCaptionSpacing={useWindowsCaptionSpacing}
        />
      ) : null}
      {showWindowControls && !isSidePaneOpen ? <DesktopWindowControls /> : null}
    </div>
  );
}
