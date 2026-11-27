/**
 * 设置中心分区入口：注入 API（真实实现或显式标注的 mock），按分区 id 渲染页面。
 * 由 SettingsPage 在 nek 分区下渲染；配置目标随项目，手动选择在本次设置中保留。
 */
import { useMemo, type ReactNode } from "react";
import type { INekWorkspaceConfigService } from "@zcode/services";
import type { RemoteTarget, RemoteWorkspaceSessionEntry } from "@zcode/shared";
import type { NekConfigTarget, NekConfigTargetInfo } from "@zcode/shared/nek-protocol";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { NekSettingsProvider, sameTarget, targetKeyOf } from "./api/NekSettingsContext.js";
import { useProjectSettingsTarget } from "./api/useProjectSettingsTarget.js";
import { ProjectHostBanner } from "./components/ProjectHostBanner.js";
import { NekPageFrame } from "./components/NekPageFrame.js";
import { DisconnectedState } from "./components/DocumentStatus.js";
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
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  onOpenRemoteProject?: (workspaceKey: string) => Promise<void>;
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
  nekRemoteHosts: (env) => (
    <RemoteHostsPage
      isWindowsDesktop={env.isWindowsDesktop}
      projects={env.remoteWorkspaceSessions}
      onOpenProject={env.onOpenRemoteProject}
    />
  ),
};

export function NekSettingsSection({
  sectionId,
  projectCwd,
  projectEnvironmentKey,
  workspace,
  projectRemoteTarget,
  selectedTarget,
  onSelectTarget,
  remoteWorkspaceSessions,
  onOpenRemoteProject,
  isWindowsDesktop = false,
}: {
  sectionId: NekSettingsSectionId;
  projectCwd?: string | null;
  projectEnvironmentKey?: string | null;
  workspace?: SettingsWorkspaceBinding;
  projectRemoteTarget?: RemoteTarget;
  selectedTarget?: NekConfigTarget;
  onSelectTarget: (target: NekConfigTarget | undefined) => void;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  onOpenRemoteProject?: (workspaceKey: string) => Promise<void>;
  isWindowsDesktop?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const base = useMemo(() => resolveNekSettingsApis(), []);
  const configPage = !["nekAppearance", "nekShortcuts", "nekRemoteHosts"].includes(sectionId);
  const scoped =
    sectionId === "nekSkills" ||
    sectionId === "nekPrompts" ||
    sectionId === "nekProject" ||
    sectionId === "nekMcp";
  const project = useProjectSettingsTarget({
    apis: base,
    workspace,
    remote: projectRemoteTarget,
    isRemote: projectEnvironmentKey !== undefined,
    selected: selectedTarget,
    scoped,
    configPage,
  });
  const workspaceService = project.viaWorkspace ? workspace?.service : undefined;
  const { target } = project;
  const targetKey = targetKeyOf(target);
  const apis = useMemo(
    () =>
      workspaceService
        ? { ...base, config: withWorkspaceConfigTarget(base.config, workspaceService, target) }
        : base,
    [base, workspaceService, targetKey],
  );
  const blocked =
    configPage &&
    project.onProjectHost &&
    (project.identifying ||
      !!project.error ||
      project.connecting ||
      (project.fixedTarget && !project.viaWorkspace));
  return (
    <NekSettingsProvider
      key={`${targetKey}:${workspaceService ? remoteAgentServiceGeneration(workspaceService) : 0}`}
      apis={apis}
      projectCwd={project.onProjectHost ? (projectCwd ?? undefined) : undefined}
      projectEnvironmentKey={projectEnvironmentKey}
      selection={{
        ...project,
        projectTarget: projectCwd ? project.projectTarget : undefined,
        setTarget: (next) =>
          onSelectTarget(sameTarget(next, project.projectTarget) ? undefined : next),
      }}
    >
      <div className="flex flex-col gap-4">
        {configPage && project.unsaved && projectRemoteTarget ? (
          <ProjectHostBanner target={projectRemoteTarget} />
        ) : null}
        {configPage && project.unresolved ? (
          <p role="alert" className="text-ui-sm text-warning">
            {intl.formatMessage({ id: "settings.nek.hostProjects.unresolved" })}
          </p>
        ) : null}
        {configPage && project.connectError ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {project.connectError}
          </p>
        ) : null}
        {blocked ? (
          <NekPageFrame usesTarget>
            {project.error ? (
              <div className="flex flex-wrap items-center gap-2">
                <p role="alert" className="text-ui-sm text-destructive">
                  {project.error}
                </p>
                <Button variant="outline" onClick={project.reload}>
                  {intl.formatMessage({ id: "common.retry" })}
                </Button>
              </div>
            ) : project.identifying || project.connecting ? (
              <p role="status" className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "common.loading" })}
              </p>
            ) : project.unsaved || project.unresolved ? null : (
              <DisconnectedState />
            )}
          </NekPageFrame>
        ) : (
          PAGES[sectionId]({
            isWindowsDesktop,
            remoteWorkspaceSessions,
            onOpenRemoteProject,
            openRemotePath: project.onProjectHost ? workspace?.openRemotePath : undefined,
          })
        )}
      </div>
    </NekSettingsProvider>
  );
}
