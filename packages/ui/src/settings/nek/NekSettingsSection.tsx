/**
 * 设置中心分区入口：注入 API（真实实现或显式标注的 mock），按分区 id 渲染页面。
 * 由 SettingsPage 在 nek 分区下渲染；配置目标状态是模块级的，切换分区时保持。
 */
import { useMemo, type ReactNode } from "react";
import { NekSettingsProvider } from "./api/NekSettingsContext.js";
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

export interface NekSettingsSectionEnv {
  isWindowsDesktop: boolean;
}

const PAGES: Partial<Record<NekSettingsSectionId, (env: NekSettingsSectionEnv) => ReactNode>> = {
  nekAccounts: () => <AccountsPage />,
  nekProviders: () => <ProvidersPage />,
  nekDefaultModel: () => <DefaultModelPage />,
  nekCompaction: () => <CompactionPage />,
  nekTools: () => <ToolsPage />,
  nekMcp: () => <McpPage />,
  nekAgent: () => <AgentPage />,
  nekProject: () => <ProjectPage />,
  nekRemoteHosts: (env) => <RemoteHostsPage isWindowsDesktop={env.isWindowsDesktop} />,
};

export function NekSettingsSection({
  sectionId,
  projectCwd,
  isWindowsDesktop = false,
}: {
  sectionId: NekSettingsSectionId;
  projectCwd?: string | null;
  isWindowsDesktop?: boolean;
}) {
  const apis = useMemo(() => resolveNekSettingsApis(), []);
  const render = PAGES[sectionId];
  return (
    <NekSettingsProvider apis={apis} projectCwd={projectCwd ?? undefined}>
      {render ? render({ isWindowsDesktop }) : null}
    </NekSettingsProvider>
  );
}
