/* eslint-disable max-lines -- 命令管理面板集中维护列表、表单和外部导入入口，拆分会增加跨状态跳转成本 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import type { CommandConfig, UserCommand, ZCodeCommand } from "@zcode/shared";
import { ZCODE_COMMAND_AGENT_SOURCE } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useCommands } from "@/hooks/useCommands.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { CommandCard, isEditableUserCommand } from "@/settings/CommandCard.js";
import { CommandForm } from "@/settings/CommandForm.js";
import { getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import { CommandsImportDialog } from "@/settings/ExternalAgentImportDialog.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import { matchesCapabilityQuery } from "@/settings/capabilityQuery.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  resolveCommandScopeRecovery,
  resolveCommandStorageTarget,
  shouldRefreshCurrentCommandList,
} from "@/settings/commandWorkspaceScope.js";

interface CommandsSectionProps {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  scopeFilter: "user" | "workspace";
  parentScopeKey: string;
  workspaceTabs: WorkspaceTabState[];
  searchQuery: string;
  onVisibleCountChange?: (count: number) => void;
  onEditorOpenChange?: (open: boolean) => void;
  onFormScopeKeyChange?: (scopeKey: string | null) => void;
}

export function CommandsSection({
  workspacePath,
  workspaceIdentity,
  scopeFilter,
  parentScopeKey,
  workspaceTabs,
  searchQuery,
  onVisibleCountChange,
  onEditorOpenChange,
  onFormScopeKeyChange,
}: CommandsSectionProps) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();

  const currentWorkspaceKey = workspaceIdentity?.trim() || workspacePath || "";
  const currentWorkspaceTab = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === currentWorkspaceKey,
  );
  // 列表按 Scope target 收到 workspacePath，但命令与插件服务仍取自当前
  // ServiceProvider，会把 B 的路径发往 A 的 remote host。两者统一走 target 解析结果，
  // 并在连接就绪前暂停 RPC，不回退到当前激活 workspace 的 service。
  const listServiceResolution = useWorkspaceServicesResolution(
    currentWorkspaceTab?.workspacePath ?? workspacePath,
    currentWorkspaceTab?.remoteSessionId,
    currentWorkspaceTab?.workspaceIdentity ?? workspaceIdentity,
    currentWorkspaceTab?.remoteTarget,
  );
  const { commandsService, settingsSyncService } = listServiceResolution.services;

  const {
    commands,
    capability,
    loading,
    error,
    operatingCommandId,
    projectionMatchesTarget,
    refresh,
    deleteCommand,
    toggleCommand,
  } = useCommands({
    workspacePath: workspacePath ?? undefined,
    workspaceIdentity,
    commandsService,
    enabled: listServiceResolution.rpcReady,
  });

  const [showForm, setShowForm] = useState(false);
  const [editingCommand, setEditingCommand] = useState<UserCommand | null>(null);
  const [saving, setSaving] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [formScopeKey, setFormScopeKey] = useState(parentScopeKey);
  const formTargetWorkspace = workspaceTabs.find(
    (tab) => getPluginWorkspaceKey(tab) === formScopeKey,
  );
  const formServiceTarget = formTargetWorkspace ?? currentWorkspaceTab;
  const formServiceResolution = useWorkspaceServicesResolution(
    formServiceTarget?.workspacePath ?? workspacePath,
    formServiceTarget?.remoteSessionId,
    formServiceTarget?.workspaceIdentity ?? workspaceIdentity,
    formServiceTarget?.remoteTarget,
  );
  const formServices = formServiceResolution.services;

  useEffect(() => {
    const recovery = resolveCommandScopeRecovery({
      editing: Boolean(editingCommand),
      scopeKey: formScopeKey,
      workspaceTabs,
    });
    if (recovery === "keep") return;
    // 目标 Workspace 关闭后不能继续向失效路径写入；新建回退 User，编辑直接退出。
    if (recovery === "close-editor") {
      setEditingCommand(null);
      setShowForm(false);
      return;
    }
    setFormScopeKey("user");
  }, [editingCommand, formScopeKey, workspaceTabs]);

  const handleSave = useCallback(
    async (config: CommandConfig, scopeKey: string) => {
      setSaving(true);
      try {
        const { storageLevel, workspace: targetWorkspace } = resolveCommandStorageTarget(
          scopeKey,
          workspaceTabs,
        );
        const targetWorkspacePath =
          storageLevel === "project" ? targetWorkspace?.workspacePath : undefined;
        if (storageLevel === "project" && !targetWorkspacePath) {
          throw new Error("Selected Workspace is no longer available");
        }
        if (editingCommand) {
          await formServices.commandsService.updateCommandFile({
            agentSource: editingCommand.agentSource,
            commandId: editingCommand.id,
            config,
            oldFilePath: editingCommand.filePath,
            storageLevel,
            workspacePath: targetWorkspacePath,
          });
        } else {
          await formServices.commandsService.writeCommandFile({
            config,
            agentSource: ZCODE_COMMAND_AGENT_SOURCE,
            storageLevel,
            workspacePath: targetWorkspacePath,
          });
        }
        if (shouldRefreshCurrentCommandList(scopeKey, currentWorkspaceKey)) {
          await refresh();
        }
        setShowForm(false);
        setEditingCommand(null);
        setFormScopeKey("user");
      } catch (saveError) {
        const message = saveError instanceof Error ? saveError.message : String(saveError);
        if (message.includes("exists") || message.includes("already")) {
          toast(
            intl.formatMessage(
              { id: "forms.validation.fileExists" },
              { fileName: `${config.name.replace(/^\//, "")}.md` },
            ),
          );
        } else {
          toast(message);
        }
      } finally {
        setSaving(false);
      }
    },
    [
      currentWorkspaceKey,
      editingCommand,
      formServices.commandsService,
      intl,
      refresh,
      workspaceTabs,
    ],
  );

  const handleDelete = useCallback(
    async (command: ZCodeCommand) => {
      if (!isEditableUserCommand(command)) {
        return;
      }
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "settings.commands.delete.title" }),
        description: intl.formatMessage(
          { id: "settings.commands.delete.description" },
          { name: command.name },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
      });
      if (!confirmed) {
        return;
      }
      try {
        await deleteCommand({
          agentSource: command.agentSource,
          commandId: command.id,
          filePath: command.filePath,
        });
        setEditingCommand(null);
        setShowForm(false);
      } catch (deleteError) {
        const message = deleteError instanceof Error ? deleteError.message : String(deleteError);
        toast(message);
      }
    },
    [confirmDialog, deleteCommand, intl],
  );

  const handleToggle = useCallback(
    async (command: ZCodeCommand, enabled: boolean) => {
      try {
        await toggleCommand({
          agentSource: command.agentSource,
          commandId: command.id,
          filePath: command.filePath,
          enabled,
        });
      } catch (toggleError) {
        const message = toggleError instanceof Error ? toggleError.message : String(toggleError);
        toast(message);
      }
    },
    [toggleCommand],
  );

  const handleEdit = useCallback(
    (command: ZCodeCommand) => {
      if (!isEditableUserCommand(command)) {
        return;
      }
      setFormScopeKey(command.scope === "project" ? parentScopeKey : "user");
      setEditingCommand(command);
      setShowForm(false);
    },
    [parentScopeKey],
  );

  const handleAddNew = useCallback(() => {
    setFormScopeKey(parentScopeKey);
    setEditingCommand(null);
    setShowForm(true);
  }, [parentScopeKey]);

  const handleCancelForm = useCallback(() => {
    setFormScopeKey("user");
    setShowForm(false);
    setEditingCommand(null);
  }, []);

  const handleFormScopeKeyChange = useCallback(
    (scopeKey: string) => {
      setFormScopeKey(scopeKey);
      onFormScopeKeyChange?.(scopeKey);
    },
    [onFormScopeKeyChange],
  );

  const scopedCommands = useMemo(
    () =>
      commands.filter(
        (command) => command.location.scope === (scopeFilter === "user" ? "user" : "project"),
      ),
    [commands, scopeFilter],
  );
  const localCommands = useMemo(
    () =>
      scopedCommands.filter(
        (command) =>
          command.agentSource === ZCODE_COMMAND_AGENT_SOURCE &&
          matchesCapabilityQuery(searchQuery, [command.name, command.description, command.prompt]),
      ),
    [scopedCommands, searchQuery],
  );
  const filteredCommandCount = localCommands.length;
  useEffect(() => {
    onVisibleCountChange?.(filteredCommandCount);
  }, [filteredCommandCount, onVisibleCountChange]);
  const hasEmptySearchResult = Boolean(searchQuery.trim()) && filteredCommandCount === 0;
  const directInstalledCommandCount = scopedCommands.length;
  const hideInstalledGroup = Boolean(searchQuery.trim()) && localCommands.length === 0;

  const renderCommandList = (items: ZCodeCommand[]) => (
    <SettingsResourceList
      items={items}
      getKey={(command) => command.id}
      renderItem={(command) => (
        <CommandCard
          command={command}
          onEdit={isEditableUserCommand(command) ? handleEdit : undefined}
          onToggle={handleToggle}
          isOperating={operatingCommandId === command.id}
        />
      )}
    />
  );

  const isFormView = showForm || editingCommand !== null;
  useEffect(() => {
    onEditorOpenChange?.(isFormView);
    onFormScopeKeyChange?.(isFormView ? formScopeKey : null);
    return () => {
      onEditorOpenChange?.(false);
      onFormScopeKeyChange?.(null);
    };
  }, [formScopeKey, isFormView, onEditorOpenChange, onFormScopeKeyChange]);
  if (isFormView) {
    return (
      <div className="space-y-6">
        <SettingsBreadcrumbReporter
          items={[
            {
              label: editingCommand?.name ?? intl.formatMessage({ id: "settings.commands.addNew" }),
            },
          ]}
          onSectionSelect={handleCancelForm}
        />
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-ui-xl font-semibold text-foreground">
              {editingCommand
                ? intl.formatMessage({ id: "settings.commands.edit" })
                : intl.formatMessage({ id: "settings.commands.addNew" })}
            </h3>
            <p className="text-ui-base text-foreground-subtle">
              {editingCommand
                ? intl.formatMessage({
                    id: "settings.commands.editDescription",
                  })
                : intl.formatMessage({
                    id: "settings.commands.addDescription",
                  })}
            </p>
          </div>

          <CommandForm
            initial={editingCommand ?? undefined}
            agentSource={editingCommand?.agentSource ?? ZCODE_COMMAND_AGENT_SOURCE}
            scopeKey={formScopeKey}
            workspaceTabs={workspaceTabs}
            onScopeKeyChange={handleFormScopeKeyChange}
            onSave={handleSave}
            onCancel={handleCancelForm}
            onDelete={editingCommand ? handleDelete : undefined}
            saving={saving}
          />
        </div>
      </div>
    );
  }

  const headerActions = (
    <SettingsResourceHeaderActions
      onRefresh={() => void refresh()}
      onImport={() => setImportDialogOpen(true)}
      onNew={handleAddNew}
      importDisabled={!capability?.userScopeAvailable}
    />
  );

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive">
          {error}
        </div>
      ) : null}

      {!listServiceResolution.rpcReady ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.connecting" })} />
      ) : loading || !projectionMatchesTarget ? (
        <PluginLoadingState label={intl.formatMessage({ id: "common.loading" })} />
      ) : hasEmptySearchResult ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.plugin.commands.searchEmpty",
          })}
        />
      ) : (
        <div className="space-y-6">
          <section className={hideInstalledGroup ? "hidden" : "space-y-4"}>
            <SettingsResourceGroupHeader
              actions={headerActions}
              count={localCommands.length}
              title={intl.formatMessage({
                id: "settings.plugin.commands.installed",
              })}
            />
            {localCommands.length > 0 ? (
              renderCommandList(localCommands)
            ) : directInstalledCommandCount === 0 && !searchQuery.trim() ? (
              <PluginInstallEmptyState
                title={intl.formatMessage({
                  id: "settings.plugin.commands.emptyInstalledTitle",
                })}
                description={intl.formatMessage({
                  id: "settings.plugin.commands.emptyInstalledDescription",
                })}
                actions={
                  <Button type="button" variant="default" size="lg" onClick={handleAddNew}>
                    <Plus data-icon="inline-start" aria-hidden="true" />
                    {intl.formatMessage({ id: "settings.create.action" })}
                  </Button>
                }
              />
            ) : null}
          </section>
        </div>
      )}
      <CommandsImportDialog
        open={importDialogOpen && listServiceResolution.rpcReady}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        settingsSyncService={settingsSyncService}
        onOpenChange={setImportDialogOpen}
        onImported={refresh}
      />
    </div>
  );
}
