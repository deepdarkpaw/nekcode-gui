import { useLayoutEffect, useRef } from "react";
import type { WorkspaceMainView } from "@/app-shell/types.js";

export function useWorkspaceMainViewSettingsExit({
  isWorkspaceVisible,
  workspaceMainView,
  onExitSettings,
}: {
  isWorkspaceVisible: boolean;
  workspaceMainView: WorkspaceMainView;
  onExitSettings: () => void;
}) {
  const wasWorkspaceVisibleRef = useRef(isWorkspaceVisible);
  const settingsEntryMainViewRef = useRef(workspaceMainView);

  useLayoutEffect(() => {
    const wasWorkspaceVisible = wasWorkspaceVisibleRef.current;
    wasWorkspaceVisibleRef.current = isWorkspaceVisible;

    if (wasWorkspaceVisible && !isWorkspaceVisible) {
      settingsEntryMainViewRef.current = workspaceMainView;
      return;
    }

    if (!wasWorkspaceVisible && isWorkspaceVisible) {
      if (workspaceMainView === settingsEntryMainViewRef.current) {
        // Settings 只是覆盖 workspace，底层 App 不卸载，进入前的
        // automations 主视图会一直保留。设置层退出时统一回到对话，
        // 让 Back、创建 Skill 和设置页快捷键共享同一导航语义。
        onExitSettings();
      }
    }
  }, [isWorkspaceVisible, onExitSettings, workspaceMainView]);
}
