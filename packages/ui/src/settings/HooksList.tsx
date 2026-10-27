import type { ReactNode } from "react";
import { Anchor, Download, ShieldCheck } from "lucide-react";
import type { Hook } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginInstallEmptyState } from "@/settings/PluginInstallEmptyState.js";
import { settingsResourceRowInteraction } from "@/settings/settingsResourceRowInteraction.js";
import { requiresWorkspaceHookTrust } from "@/settings/WorkspaceHookTrustNotice.js";

export type HookScope = "user" | "project";

type HookSection =
  | { kind: "installed"; title: "Installed"; count: number; hooks: Hook[] }
  | { kind: "legacy"; title: "Legacy"; count: number; hooks: Hook[] };

function groupHookSections(editableHooks: Hook[], compatibilityHooks: Hook[]): HookSection[] {
  const sections: HookSection[] = [];
  if (editableHooks.length > 0) {
    sections.push({
      kind: "installed",
      title: "Installed",
      count: editableHooks.length,
      hooks: editableHooks,
    });
  }
  if (compatibilityHooks.length > 0) {
    sections.push({
      kind: "legacy",
      title: "Legacy",
      count: compatibilityHooks.length,
      hooks: compatibilityHooks,
    });
  }
  return sections;
}

export function HooksList({
  compatibilityHooks,
  editableHooks,
  operatingHookId,
  trustActionAvailable = false,
  trustingHookId,
  onEdit,
  onImport,
  onTrust,
  onToggle,
  installedAction,
  installedEmptyActions,
  installedEmptyDescription,
  installedEmptyTitle,
  showInstalledSection = false,
}: {
  compatibilityHooks: Hook[];
  editableHooks: Hook[];
  operatingHookId: string | null;
  trustActionAvailable?: boolean;
  trustingHookId?: string | null;
  onEdit: (hook: Hook) => void;
  onImport: (hook: Hook) => Promise<void>;
  onTrust?: (hook: Hook) => Promise<void>;
  onToggle: (hook: Hook, enabled: boolean) => Promise<void>;
  installedAction?: ReactNode;
  installedEmptyActions?: ReactNode;
  installedEmptyDescription?: string;
  installedEmptyTitle?: string;
  showInstalledSection?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const groupedSections = groupHookSections(editableHooks, compatibilityHooks);
  const sections: HookSection[] =
    showInstalledSection && editableHooks.length === 0
      ? [{ kind: "installed", title: "Installed", count: 0, hooks: [] }, ...groupedSections]
      : groupedSections;

  return (
    <div className="space-y-6">
      {sections.map((section) => (
        <section key={`${section.kind}:${section.title}`} className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="flex h-7 items-center gap-1.5 text-ui-base font-medium text-foreground">
              {intl.formatMessage({
                id:
                  section.kind === "installed"
                    ? "settings.hooks.group.installed"
                    : "settings.hooks.group.legacy",
              })}
              <span className="text-ui-sm font-normal text-foreground-subtle">{section.count}</span>
            </h3>
            {section.kind === "installed" ? installedAction : null}
          </div>
          {section.kind === "installed" && section.hooks.length === 0 ? (
            <PluginInstallEmptyState
              title={installedEmptyTitle ?? ""}
              description={installedEmptyDescription ?? ""}
              actions={installedEmptyActions}
            />
          ) : (
            <div className="overflow-hidden rounded-xl bg-surface">
              {section.hooks.map((hook, index) => (
                <div key={hook.id}>
                  {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                  {section.kind === "installed" ? (
                    <ConfiguredHookRow
                      hook={hook}
                      busy={operatingHookId === hook.id}
                      readOnly={hook.editable === false}
                      requiresTrust={requiresWorkspaceHookTrust(hook)}
                      trustActionAvailable={trustActionAvailable}
                      trusting={trustingHookId === hook.id}
                      onToggle={onToggle}
                      onEdit={onEdit}
                      onTrust={onTrust}
                    />
                  ) : (
                    <CompatibilityHookRow
                      hook={hook}
                      busy={operatingHookId === hook.id}
                      onImport={onImport}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function HookItemFrame({
  actions,
  children,
  onEdit,
  testId,
}: {
  actions?: ReactNode;
  children: ReactNode;
  onEdit?: () => void;
  testId?: string;
}) {
  return (
    <div
      className={`grid cursor-default grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-4 py-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] ${onEdit ? "transition-colors hover:bg-hover" : ""}`}
      data-testid={testId}
      {...settingsResourceRowInteraction(onEdit)}
    >
      <div
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-foreground-subtle"
        aria-hidden="true"
      >
        <Anchor className="size-4" />
      </div>
      <div className="min-w-0">{children}</div>
      {actions ? (
        <div className="col-start-2 flex shrink-0 items-center justify-end gap-2 sm:col-start-auto">
          {actions}
        </div>
      ) : null}
    </div>
  );
}

function HookContent({
  event,
  command,
  trailingBadges,
}: {
  event: string;
  command: string;
  trailingBadges?: ReactNode;
}) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-ui-base font-medium text-foreground">{event}</span>
        {trailingBadges}
      </div>
      <p className="mt-1 truncate font-mono text-ui-sm text-foreground-subtle">{command}</p>
    </>
  );
}

function ConfiguredHookRow({
  busy,
  hook,
  onEdit,
  onTrust,
  onToggle,
  readOnly = false,
  requiresTrust,
  trustActionAvailable,
  trusting,
}: {
  busy: boolean;
  hook: Hook;
  onEdit: (hook: Hook) => void;
  onTrust?: (hook: Hook) => Promise<void>;
  onToggle: (hook: Hook, enabled: boolean) => Promise<void>;
  /** 上游/祖先 zcode.json 的只读工作区 Hook：不可编辑、不可 toggle，但仍可逐条 Trust。 */
  readOnly?: boolean;
  requiresTrust: boolean;
  trustActionAvailable: boolean;
  trusting: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <HookItemFrame
      testId="configured-hook-row"
      onEdit={busy || readOnly ? undefined : () => onEdit(hook)}
      actions={
        <>
          {requiresTrust && onTrust ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || trusting || !trustActionAvailable}
              title={
                trustActionAvailable
                  ? undefined
                  : intl.formatMessage({ id: "settings.hooks.review.unavailable" })
              }
              onClick={(event) => {
                event.stopPropagation();
                void onTrust(hook);
              }}
            >
              <ShieldCheck className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.hooks.review.trust" })}
            </Button>
          ) : null}
          {/* workspace-hook-trust：未通过信任审核的工作区 Hook 禁止直接启用，
              Switch 强制关闭并禁用，引导用户先完成 Trust 审核流程。
              只读行（上游 zcode.json）的 Switch 始终禁用：信任后展示真实配置状态，
              但启用/禁用必须去源文件改，Settings 不提供写入口。 */}
          <Switch
            checked={requiresTrust ? false : hook.enabled}
            onCheckedChange={(value) => void onToggle(hook, value)}
            onClick={(event) => event.stopPropagation()}
            disabled={busy || trusting || requiresTrust || readOnly}
          />
        </>
      }
    >
      <HookContent event={hook.event} command={[hook.command, ...(hook.args ?? [])].join(" ")} />
    </HookItemFrame>
  );
}

function CompatibilityHookRow({
  busy,
  hook,
  onImport,
}: {
  busy: boolean;
  hook: Hook;
  onImport: (hook: Hook) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <HookItemFrame
      actions={
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void onImport(hook)}>
          <Download className="size-3" />
          {intl.formatMessage({ id: "settings.hooks.import" })}
        </Button>
      }
    >
      <HookContent event={hook.event} command={[hook.command, ...(hook.args ?? [])].join(" ")} />
    </HookItemFrame>
  );
}
