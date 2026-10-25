/**
 * 项目（当前工作区）：信任状态与需要信任的资源；项目级 settings 覆盖（显示继承来的全局值）；
 * 项目 MCP 覆盖、项目 AGENTS.md 与项目子代理。
 */
import type { ReactNode } from "react";
import { FolderGit2Icon, ShieldCheckIcon, ShieldOffIcon, ShieldQuestionIcon } from "lucide-react";
import type {
  NekCatalogModel,
  NekSettingsView,
  NekThinkingLevel,
} from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { SettingRow, SettingSection, useInstantCommit } from "@/components/ui/setting-fields.js";
import { SettingTextField } from "@/components/ui/setting-text-field.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNekConfigApi, useNekSettingsContext, useNekTarget } from "../api/NekSettingsContext.js";
import { useNekAgentPresetsDoc, useNekMcpDoc } from "../api/mcpDocs.js";
import {
  settingOrDefault,
  useNekSettingsDoc,
  type NekSettingsDocument,
} from "../api/settingsDocs.js";
import { useNekQuery } from "../api/useNekQuery.js";
import {
  findCatalogModel,
  formatModelRef,
  parseModelRef,
  supportedThinkingLevels,
} from "../lib/modelRef.js";
import { DocumentGate, NekEmptyState } from "../components/DocumentStatus.js";
import { ModelSelect, ThinkingLevelSelect, UNSET_VALUE } from "../components/modelControls.js";
import { NekPageFrame } from "../components/NekPageFrame.js";
import { AgentPresetsSection } from "./agent/AgentPresetsSection.js";
import { InstructionsEditor } from "./agent/InstructionsEditor.js";
import { ServerList } from "./mcp/McpPage.js";

function TrustSection({ cwd }: { cwd: string }) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const api = useNekConfigApi();
  const { target } = useNekTarget();
  const trust = useNekQuery((config, current) => config.getProjectTrust(current, cwd), [cwd]);
  const state =
    trust.data?.trusted === true
      ? "trusted"
      : trust.data?.trusted === false
        ? "untrusted"
        : "undecided";
  const Icon =
    state === "trusted"
      ? ShieldCheckIcon
      : state === "untrusted"
        ? ShieldOffIcon
        : ShieldQuestionIcon;
  const set = async (trusted: boolean) => {
    await api.setProjectTrust(target, cwd, trusted);
    await trust.reload();
  };
  return (
    <SettingSection
      title={t("settings.nek.project.trust")}
      description={t("settings.nek.project.trustHint")}
    >
      <DocumentGate documents={[trust]}>
        {() => (
          <div className="flex flex-col gap-3 rounded-xl border border-card-border bg-card p-4">
            <p className="flex items-center gap-2 text-ui-base" role="status">
              <Icon className="size-4" aria-hidden="true" />
              {t(`settings.nek.project.trustState.${state}`, {
                policy: t(
                  `settings.nek.project.policy.${trust.data?.defaultProjectTrust ?? "ask"}`,
                ),
              })}
            </p>
            <ul className="flex flex-col gap-0.5">
              {trust.data?.resources.map((resource) => (
                <li key={resource.path} className="flex items-center gap-2 text-ui-sm">
                  <span className="w-24 shrink-0 text-foreground-subtle">
                    {t(`settings.nek.project.resource.${resource.kind}`)}
                  </span>
                  <span className="truncate font-mono text-foreground">{resource.path}</span>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <AsyncButton
                variant={state === "trusted" ? "outline" : "default"}
                disabled={state === "trusted"}
                disabledReason={t("settings.nek.project.alreadyTrusted")}
                onClick={() => set(true)}
              >
                {t("settings.nek.project.trustAction")}
              </AsyncButton>
              <AsyncButton
                variant="ghost"
                disabled={state === "untrusted"}
                disabledReason={t("settings.nek.project.alreadyUntrusted")}
                onClick={() => set(false)}
              >
                {t("settings.nek.project.untrustAction")}
              </AsyncButton>
            </div>
          </div>
        )}
      </DocumentGate>
    </SettingSection>
  );
}

function InheritedHint({ value }: { value: ReactNode }) {
  const { intl } = useZCodeIntl();
  return (
    <span className="text-foreground-subtlest">
      {intl.formatMessage(
        { id: "settings.nek.project.inherited" },
        { value: String(value ?? "—") },
      )}
    </span>
  );
}

type QueueMode = NonNullable<NekSettingsView["steeringMode"]>;

function QueueModeOverride({
  project,
  global,
  field,
}: {
  project: NekSettingsDocument;
  global: NekSettingsView;
  field: "steeringMode" | "followUpMode";
}) {
  const { intl } = useZCodeIntl();
  const inherited = global[field] ?? "one-at-a-time";
  const commit = useInstantCommit<QueueMode | undefined>(project.data?.values[field], (value) =>
    project.patch({ [field]: value ?? null }),
  );
  return (
    <SettingRow
      label={intl.formatMessage({ id: `settings.nek.advanced.${field}` })}
      description={
        <InheritedHint
          value={intl.formatMessage({ id: `settings.nek.advanced.queue.${inherited}` })}
        />
      }
      state={commit.action.state}
    >
      <Select
        value={commit.displayValue ?? UNSET_VALUE}
        onValueChange={(next) =>
          commit.commit(next === UNSET_VALUE ? undefined : (next as QueueMode))
        }
      >
        <SelectTrigger
          className="w-44"
          aria-label={intl.formatMessage({ id: `settings.nek.advanced.${field}` })}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET_VALUE}>
            {intl.formatMessage({ id: "settings.nek.project.inherit" })}
          </SelectItem>
          <SelectItem value="one-at-a-time">
            {intl.formatMessage({ id: "settings.nek.advanced.queue.one-at-a-time" })}
          </SelectItem>
          <SelectItem value="all">
            {intl.formatMessage({ id: "settings.nek.advanced.queue.all" })}
          </SelectItem>
        </SelectContent>
      </Select>
    </SettingRow>
  );
}

function OverridesSection({
  project,
  global,
  models,
}: {
  project: NekSettingsDocument;
  global: NekSettingsDocument;
  models: readonly NekCatalogModel[];
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const values = project.data?.values ?? {};
  const globalView: NekSettingsView = { ...global.data?.defaults, ...global.data?.values };
  const globalRef =
    globalView.defaultProvider && globalView.defaultModel
      ? formatModelRef(globalView.defaultProvider, globalView.defaultModel)
      : undefined;
  const projectRef =
    values.defaultProvider && values.defaultModel
      ? formatModelRef(values.defaultProvider, values.defaultModel)
      : undefined;
  const model = useInstantCommit<string | undefined>(projectRef, async (ref) => {
    const parsed = ref ? parseModelRef(ref) : null;
    await project.patch(
      parsed
        ? { defaultProvider: parsed.provider, defaultModel: parsed.id }
        : { defaultProvider: null, defaultModel: null },
    );
  });
  const level = useInstantCommit<NekThinkingLevel | undefined>(
    values.defaultThinkingLevel,
    (next) => project.patch({ defaultThinkingLevel: next ?? null }),
  );
  const effectiveModel = findCatalogModel(models, model.displayValue ?? globalRef);
  return (
    <SettingSection
      title={t("settings.nek.project.overrides")}
      description={
        project.data ? <span className="font-mono">{project.data.path}</span> : undefined
      }
    >
      <SettingRow
        label={t("settings.nek.defaultModel.model")}
        description={<InheritedHint value={globalRef} />}
        state={model.action.state}
      >
        <ModelSelect
          ariaLabel={t("settings.nek.defaultModel.model")}
          value={model.displayValue}
          models={models}
          unsetLabel={t("settings.nek.project.inherit")}
          onChange={model.commit}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.nek.defaultModel.thinking")}
        description={
          <InheritedHint
            value={settingOrDefault(global.data, (view) => view.defaultThinkingLevel)}
          />
        }
        state={level.action.state}
      >
        <ThinkingLevelSelect
          ariaLabel={t("settings.nek.defaultModel.thinking")}
          value={level.displayValue}
          levels={supportedThinkingLevels(effectiveModel)}
          unsetLabel={t("settings.nek.project.inherit")}
          onChange={level.commit}
        />
      </SettingRow>
      <SettingTextField
        label={t("settings.nek.tools.shellPath")}
        description={
          <InheritedHint
            value={globalView.shellPath || t("settings.nek.tools.shellPathPlaceholder")}
          />
        }
        value={values.shellPath ?? ""}
        placeholder={t("settings.nek.project.inherit")}
        inputClassName="w-72 font-mono"
        onCommit={(shellPath) => project.patch({ shellPath: shellPath || null })}
      />
      <QueueModeOverride project={project} global={globalView} field="steeringMode" />
      <QueueModeOverride project={project} global={globalView} field="followUpMode" />
    </SettingSection>
  );
}

function ProjectBody({ cwd }: { cwd: string }) {
  const { intl } = useZCodeIntl();
  const project = useNekSettingsDoc("project", cwd);
  const global = useNekSettingsDoc("global");
  const mcp = useNekMcpDoc("project", cwd);
  const presets = useNekAgentPresetsDoc(cwd);
  const status = useNekQuery((api, target) => api.getMcpStatus(target, cwd), [cwd]);
  const available = useNekQuery((api, target) => api.listAvailableModels(target), []);
  return (
    <NekPageFrame
      usesTarget
      description={intl.formatMessage({ id: "settings.nek.project.pageDescription" }, { cwd })}
      documents={[project, mcp, presets]}
    >
      <div className="flex flex-col gap-8">
        <TrustSection cwd={cwd} />
        <DocumentGate documents={[project, global]}>
          {() => (
            <OverridesSection project={project} global={global} models={available.data ?? []} />
          )}
        </DocumentGate>
        <SettingSection
          title={intl.formatMessage({ id: "settings.nek.mcp.projectTitle" })}
          description={intl.formatMessage({ id: "settings.nek.project.mcpHint" })}
        >
          <DocumentGate documents={[mcp]}>
            {() =>
              mcp.data?.servers.length ? (
                <ServerList
                  doc={mcp}
                  statuses={status.data ?? undefined}
                  statusReload={status.reload}
                  cwd={cwd}
                  onEdit={() => undefined}
                />
              ) : (
                <p className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.nek.project.noMcp" })}
                </p>
              )
            }
          </DocumentGate>
        </SettingSection>
        <AgentPresetsSection
          doc={presets}
          models={available.data ?? []}
          sources={["project"]}
          allowProjectScope={false}
          title={intl.formatMessage({ id: "settings.nek.project.presets" })}
        />
        <InstructionsEditor
          scope="project"
          cwd={cwd}
          title={intl.formatMessage({ id: "settings.nek.project.instructions" })}
        />
      </div>
    </NekPageFrame>
  );
}

export function ProjectPage() {
  const { intl } = useZCodeIntl();
  const { projectCwd } = useNekSettingsContext();
  if (!projectCwd) {
    return (
      <NekPageFrame usesTarget>
        <NekEmptyState
          icon={<FolderGit2Icon className="size-5" aria-hidden="true" />}
          title={intl.formatMessage({ id: "settings.nek.project.noWorkspace" })}
          description={intl.formatMessage({ id: "settings.nek.project.noWorkspaceHint" })}
        />
      </NekPageFrame>
    );
  }
  return <ProjectBody cwd={projectCwd} />;
}
