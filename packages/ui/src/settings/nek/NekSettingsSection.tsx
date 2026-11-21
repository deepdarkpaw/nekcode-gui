/**
 * 设置中心分区入口：注入 API（真实实现或显式标注的 mock），按分区 id 渲染页面。
 * 由 SettingsPage 在 nek 分区下渲染；配置目标状态是模块级的，切换分区时保持。
 */
import { useMemo, type ReactNode } from "react";
import type { INekWorkspaceConfigService } from "@zcode/services";
import type { NekConfigTargetInfo } from "@zcode/shared/nek-protocol";
import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { LOCAL_TARGET, NekSettingsProvider } from "./api/NekSettingsContext.js";
import { withWorkspaceConfigTarget } from "./api/workspaceConfigTarget.js";
import { resolveNekSettingsApis } from "./api/registry.js";
import type { NekSettingsSectionId } from "./sections.js";
import { AccountsPage } from "./pages/accounts/AccountsPage.js";
import { ProvidersPage } from "./pages/providers/ProvidersPage.js";
import { DefaultModelPage } from "./pages/DefaultModelPage.js";
import { CompactionPage } from "./pages/CompactionPage.js";
import { ToolsPage } from "./pages/ToolsPage.js";
import { McpPage } from "./pages/mcp/McpPage.js";
import { AgentPage } from "./pages/agent/AgentPage.js";
import { ProjectPage } from "./pages/ProjectPage.js";
import { RemoteHostsPage } from "./pages/hosts/RemoteHostsPage.js";
import { AppearancePage } from "./pages/AppearancePage.js";
import { ShortcutsPage } from "./pages/ShortcutsPage.js";
import { AdvancedPage } from "./pages/AdvancedPage.js";
import { AboutPage } from "./pages/AboutPage.js";
import { ResourcesPage } from "./pages/resources/ResourcesPage.js";

export interface SettingsWorkspaceBinding {
  service: INekWorkspaceConfigService;
  info?: NekConfigTargetInfo;
  openRemotePath?: (path: string, pathKind: "file" | "directory") => Promise<void>;
}

export interface NekSettingsSectionEnv {
  isWindowsDesktop: boolean;
  openRemotePath?: (path: string, pathKind: "file" | "directory") => Promise<void>;
}

const PAGES: Readonly<Record<NekSettingsSectionId, (env: NekSettingsSectionEnv) => ReactNode>> = {
  nekAccounts: () => <AccountsPage />,
  nekProviders: () => <ProvidersPage />,
  nekDefaultModel: () => <DefaultModelPage />,
  nekCompaction: () => <CompactionPage />,
  nekTools: () => <ToolsPage />,
  nekMcp: () => <McpPage />,
  nekAgent: () => <AgentPage />,
  nekProject: () => <ProjectPage />,
  nekSkills: ({ openRemotePath }) => (
    <ResourcesPage resourceType="skills" openRemotePath={openRemotePath} />
  ),
  nekPrompts: ({ openRemotePath }) => (
    <ResourcesPage resourceType="prompts" openRemotePath={openRemotePath} />
  ),
  nekAppearance: () => <AppearancePage />,
  nekShortcuts: () => <ShortcutsPage />,
  nekAdvanced: () => <AdvancedPage />,
  nekAbout: () => <AboutPage />,
  nekRemoteHosts: (env) => <RemoteHostsPage isWindowsDesktop={env.isWindowsDesktop} />,
};

export function NekSettingsSection({
  sectionId,
  projectCwd,
  workspace,
  isWindowsDesktop = false,
}: {
  sectionId: NekSettingsSectionId;
  projectCwd?: string | null;
  workspace?: SettingsWorkspaceBinding;
  isWindowsDesktop?: boolean;
}) {
  const base = useMemo(() => resolveNekSettingsApis(), []);
  const scoped =
    sectionId === "nekSkills" ||
    sectionId === "nekPrompts" ||
    sectionId === "nekProject" ||
    sectionId === "nekMcp";
  const workspaceService = scoped && !base.isMock ? workspace?.service : undefined;
  const workspaceTarget = workspaceService && projectCwd ? workspace?.info : undefined;
  const target = workspaceTarget?.target ?? LOCAL_TARGET;
  const apis = useMemo(
    () =>
      workspaceService
        ? { ...base, config: withWorkspaceConfigTarget(base.config, workspaceService, target) }
        : base,
    [base, workspaceService, target],
  );
  const render = PAGES[sectionId];
  return (
    <NekSettingsProvider
      key={workspaceService ? remoteAgentServiceGeneration(workspaceService) : 0}
      apis={apis}
      projectCwd={projectCwd ?? undefined}
      workspaceTarget={workspaceTarget}
    >
      {render({ isWindowsDesktop, openRemotePath: workspaceTarget && workspace?.openRemotePath })}
    </NekSettingsProvider>
  );
}
