import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "@/components/ui/toast.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { getPathLeaf } from "@/lib/path.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SkillsSection } from "@/settings/SkillsSection.js";
import { CommandsSection } from "@/settings/CommandsSection.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";
import {
  PluginScopeMenu,
  getPluginWorkspaceKey,
  isPluginScopeWorkspaceConnected,
} from "@/settings/PluginScopeMenu.js";

/** 设置页能力分区：技能与命令共用「作用域 + 计数 + 搜索」外壳。 */
type CapabilityMode = "skill" | "command";

interface CapabilitySectionProps {
  mode: CapabilityMode;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  onCreateTask?: (request?: CreateTaskRequest) => void;
}

type CapabilityScope =
  | { kind: "user"; key: "user" }
  | { kind: "workspace"; key: string; tab: WorkspaceTabState };

/** 已连接 workspace tab 去重；启动恢复时 active workspace 可能先于 tabs 出现，需要补进来。 */
function useScopeWorkspaceTabs(
  workspacePath: string | null | undefined,
  workspaceIdentity: string | undefined,
): WorkspaceTabState[] {
  const tabs = useTabStore((state) => state.tabs);
  const storeActivePath = useTabStore((state) => state.activeWorkspacePath);
  const storeActiveIdentity = useTabStore((state) => state.activeWorkspaceIdentity);
  const activePath = workspacePath ?? storeActivePath;
  const activeIdentity = workspaceIdentity ?? storeActiveIdentity ?? undefined;
  return useMemo(() => {
    const seen = new Set<string>();
    const scoped = tabs
      .filter(isWorkspaceTab)
      .filter(isPluginScopeWorkspaceConnected)
      .filter((tab) => {
        const key = getPluginWorkspaceKey(tab);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const activeKey = activeIdentity?.trim() || activePath;
    if (
      activePath &&
      !activeIdentity?.trim() &&
      !scoped.some((tab) => getPluginWorkspaceKey(tab) === activeKey)
    ) {
      scoped.push({
        id: `__active_workspace__:${activeKey}`,
        kind: "workspace",
        workspacePath: activePath,
        workspaceIdentity: activeIdentity,
        label: getPathLeaf(activePath) || activePath,
      });
    }
    return scoped;
  }, [activeIdentity, activePath, tabs]);
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-ui-base text-foreground-subtle">
      {message}
    </div>
  );
}

export function CapabilitySection({
  mode,
  workspacePath,
  workspaceIdentity,
  onCreateTask,
}: CapabilitySectionProps) {
  const { intl } = useZCodeIntl();
  const workspaceTabs = useScopeWorkspaceTabs(workspacePath, workspaceIdentity);
  const activeKey = workspaceIdentity?.trim() || workspacePath || "";
  const preferredHost =
    workspaceTabs.find((tab) => getPluginWorkspaceKey(tab) === activeKey) ??
    workspaceTabs[0] ??
    null;
  const [scopeKey, setScopeKey] = useState("user");
  const [searchQuery, setSearchQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(0);
  const [editorOpen, setEditorOpen] = useState(false);
  const [formScopeKey, setFormScopeKey] = useState<string | null>(null);

  const scope: CapabilityScope = useMemo(() => {
    const tab = workspaceTabs.find((candidate) => getPluginWorkspaceKey(candidate) === scopeKey);
    return tab
      ? { kind: "workspace", key: getPluginWorkspaceKey(tab), tab }
      : { kind: "user", key: "user" };
  }, [scopeKey, workspaceTabs]);
  const target = scope.kind === "workspace" ? scope.tab : preferredHost;
  const effectiveCommandScopeKey = editorOpen && formScopeKey ? formScopeKey : scopeKey;
  const commandWorkspace = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === effectiveCommandScopeKey,
  );
  // 编辑器锁定的 Workspace 断连后不能回退到另一个项目，否则保存会写错位置。
  const commandWorkspaceMissing = Boolean(
    editorOpen && formScopeKey && formScopeKey !== "user" && !commandWorkspace,
  );
  const commandTarget = commandWorkspaceMissing ? null : (commandWorkspace ?? preferredHost);

  useEffect(() => {
    if (!commandWorkspaceMissing) return;
    setEditorOpen(false);
    setFormScopeKey(null);
  }, [commandWorkspaceMissing]);

  useEffect(() => {
    if (scopeKey === "user") return;
    if (workspaceTabs.some((tab) => getPluginWorkspaceKey(tab) === scopeKey)) return;
    // 选中的 workspace 已关闭或断连：显式切回 User 并提示，避免误以为仍在展示项目配置。
    setScopeKey("user");
    toast(intl.formatMessage({ id: "settings.plugin.scopeUnavailableFallback" }));
  }, [intl, scopeKey, workspaceTabs]);

  const updateCount = useCallback((count: number) => setVisibleCount(count), []);
  const titleId = mode === "skill" ? "settings.plugin.tab.skills" : "settings.plugin.tab.commands";
  const placeholderId =
    mode === "skill" ? "settings.skills.searchPlaceholder" : "settings.commands.searchPlaceholder";
  const noWorkspace = (
    <EmptyState message={intl.formatMessage({ id: "settings.plugin.noWorkspace" })} />
  );

  return (
    <div className="space-y-6">
      {!editorOpen ? (
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <PluginScopeMenu
              align="start"
              selectedScopeKey={scopeKey}
              triggerTestId="plugin-settings-scope-trigger"
              userOptionTestId="plugin-settings-scope-user-option"
              workspaceOptionTestIdPrefix="plugin-settings-scope-option"
              workspaceTabs={workspaceTabs}
              onScopeKeyChange={setScopeKey}
            />
            <div className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />
            <div
              data-independent-capability-count="true"
              className="flex h-7 items-center gap-1 px-3 text-ui-base font-medium text-foreground"
            >
              <span>{intl.formatMessage({ id: titleId })}</span>
              <span className="text-ui-sm text-foreground-subtle">{visibleCount}</span>
            </div>
          </div>
          <SettingsSearchInput
            data-testid="plugin-settings-search"
            containerClassName="w-full sm:ml-auto sm:w-64"
            clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
            value={searchQuery}
            onClear={() => setSearchQuery("")}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={intl.formatMessage({ id: placeholderId })}
          />
        </div>
      ) : null}
      {mode === "skill" ? (
        target ? (
          <SkillsSection
            workspacePath={target.workspacePath}
            workspaceIdentity={target.workspaceIdentity}
            remoteSessionId={target.remoteSessionId}
            remoteTarget={target.remoteTarget}
            scopeFilter={scope.kind === "user" ? "user" : "workspace"}
            searchQuery={searchQuery}
            onCreateTask={onCreateTask}
            onVisibleCountChange={updateCount}
          />
        ) : (
          noWorkspace
        )
      ) : commandTarget ? (
        <CommandsSection
          workspacePath={commandTarget.workspacePath}
          workspaceIdentity={commandTarget.workspaceIdentity}
          scopeFilter={effectiveCommandScopeKey === "user" ? "user" : "workspace"}
          parentScopeKey={scopeKey}
          workspaceTabs={workspaceTabs}
          searchQuery={searchQuery}
          onVisibleCountChange={updateCount}
          onEditorOpenChange={setEditorOpen}
          onFormScopeKeyChange={setFormScopeKey}
        />
      ) : (
        noWorkspace
      )}
    </div>
  );
}
