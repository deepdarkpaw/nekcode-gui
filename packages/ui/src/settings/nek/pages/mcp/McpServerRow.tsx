/**
 * 单个 MCP 服务器：启停、状态、工具数；展开后：暴露方式、超时、描述、逐工具暴露（折叠）、
 * 测试、重连、OAuth 登录 / 退出、编辑、删除（带撤销）。项目级覆盖只允许改 enabled / exposure / toolExposure。
 */
import { useState } from "react";
import {
  LogInIcon,
  LogOutIcon,
  PencilIcon,
  PlugIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import type {
  NekMcpExposure,
  NekMcpServerEntry,
  NekMcpServerStatus,
} from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Fold, FoldContent, FoldTrigger, useFoldState } from "@/components/ui/fold.js";
import { IconButton } from "@/components/ui/icon-button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  SettingRow,
  SettingSelectField,
  useInstantCommit,
} from "@/components/ui/setting-fields.js";
import { SettingNumberField, SettingTextField } from "@/components/ui/setting-text-field.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { MCP_DEFAULT_TIMEOUT_SECONDS, MCP_EXPOSURES, mcpTransportOf } from "../../lib/mcpForm.js";

export type McpRowState = NekMcpServerStatus["state"] | "notRunning";

const STATE_CLASSNAME: Record<McpRowState, string> = {
  connected: "bg-success",
  connecting: "bg-warning",
  failed: "bg-destructive",
  needs_auth: "bg-warning",
  disabled: "bg-foreground-subtlest",
  notRunning: "bg-foreground-subtlest",
};

export function rowStateOf(
  entry: NekMcpServerEntry,
  status: NekMcpServerStatus | undefined,
): McpRowState {
  if (entry.config.enabled === false) return "disabled";
  return status?.state ?? "notRunning";
}

export interface McpRowActions {
  setEnabled: (enabled: boolean) => Promise<void>;
  setExposure: (exposure: NekMcpExposure) => Promise<void>;
  setToolExposure: (tool: string, exposure: NekMcpExposure) => Promise<void>;
  /** 以下只对完整条目（非项目覆盖）提供。 */
  setTimeout?: (seconds: number | undefined) => Promise<void>;
  setDescription?: (description: string) => Promise<void>;
  edit?: () => void;
  remove: () => void;
  test: () => Promise<string>;
  action: (action: "reconnect" | "login" | "logout") => Promise<void>;
}

function ToolExposureSelect({
  tool,
  value,
  onCommit,
}: {
  tool: string;
  value: NekMcpExposure;
  onCommit: (value: NekMcpExposure) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const commit = useInstantCommit(value, onCommit);
  return (
    <Select
      value={commit.displayValue}
      onValueChange={(next) => commit.commit(next as NekMcpExposure)}
    >
      <SelectTrigger
        size="sm"
        className="w-28"
        aria-label={intl.formatMessage({ id: "settings.nek.mcp.toolExposureLabel" }, { tool })}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {MCP_EXPOSURES.map((exposure) => (
          <SelectItem key={exposure} value={exposure}>
            {intl.formatMessage({ id: `settings.nek.mcp.exposure.${exposure}` })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ToolList({
  entry,
  status,
  actions,
}: {
  entry: NekMcpServerEntry;
  status: NekMcpServerStatus | undefined;
  actions: McpRowActions;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useFoldState(`nek-mcp-tools:${entry.scope}:${entry.name}`, null, false);
  const tools = status?.tools ?? [];
  if (tools.length === 0) {
    return (
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.nek.mcp.noTools" })}
      </p>
    );
  }
  return (
    <Fold open={open} onOpenChange={setOpen}>
      <FoldTrigger className="h-7 text-ui-sm text-foreground-subtle hover:text-foreground">
        {intl.formatMessage({ id: "settings.nek.mcp.tools" }, { count: tools.length })}
      </FoldTrigger>
      <FoldContent>
        <ul className="flex flex-col gap-1 py-1 pl-5">
          {tools.map((tool) => (
            <li key={tool.name} className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-ui-sm">{tool.name}</span>
              <ToolExposureSelect
                tool={tool.name}
                value={entry.config.toolExposure?.[tool.name] ?? tool.exposure}
                onCommit={(exposure) => actions.setToolExposure(tool.name, exposure)}
              />
            </li>
          ))}
        </ul>
      </FoldContent>
    </Fold>
  );
}

export function McpServerRow({
  entry,
  status,
  actions,
}: {
  entry: NekMcpServerEntry;
  status: NekMcpServerStatus | undefined;
  actions: McpRowActions;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const [open, setOpen] = useFoldState(`nek-mcp:${entry.scope}:${entry.name}`, null, false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const enabled = useInstantCommit(entry.config.enabled !== false, actions.setEnabled);
  const state = rowStateOf(entry, status);
  const toolCount = status?.tools.length;
  const auth = status?.auth;
  return (
    <Fold
      open={open}
      onOpenChange={setOpen}
      className="rounded-xl border border-card-border bg-card"
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <FoldTrigger chevron="start" className="min-w-0 flex-1 gap-2">
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2">
              <span className="truncate font-mono text-ui-base text-foreground">{entry.name}</span>
              <span className="rounded-sm bg-tag px-1 text-ui-xs text-foreground-subtle">
                {t(`settings.nek.mcp.transport.${mcpTransportOf(entry.config)}`)}
              </span>
              <span className="rounded-sm bg-tag px-1 text-ui-xs text-foreground-subtle">
                {t(
                  entry.isOverride
                    ? "settings.nek.mcp.scope.override"
                    : `settings.nek.mcp.scope.${entry.scope}`,
                )}
              </span>
            </span>
            {entry.config.description ? (
              <span className="truncate text-ui-sm text-foreground-subtle">
                {entry.config.description}
              </span>
            ) : null}
            <span
              title={entry.path}
              className="truncate font-mono text-ui-xs text-foreground-subtlest"
            >
              {t("settings.nek.mcp.source", { path: entry.path })}
            </span>
          </span>
        </FoldTrigger>
        <span
          className="flex items-center gap-1.5 text-ui-sm text-foreground-subtle"
          title={status?.error}
        >
          <span aria-hidden="true" className={cn("size-2 rounded-full", STATE_CLASSNAME[state])} />
          {t(`settings.nek.mcp.state.${state}`)}
          {toolCount !== undefined && state === "connected" ? (
            <span>· {t("settings.nek.mcp.toolCount", { count: toolCount })}</span>
          ) : null}
        </span>
        <Switch
          checked={enabled.displayValue}
          aria-label={t("settings.nek.mcp.enabledLabel", { name: entry.name })}
          onCheckedChange={enabled.commit}
        />
      </div>
      {enabled.action.state.status === "error" ? (
        <p role="alert" className="px-3 pb-2 text-ui-sm text-destructive">
          {enabled.action.state.message}
        </p>
      ) : null}
      <FoldContent>
        <div className="flex flex-col gap-1 border-t border-border px-3 py-2">
          {status?.error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {status.error}
            </p>
          ) : null}
          <SettingSelectField
            label={t("settings.nek.mcp.exposure")}
            description={t("settings.nek.mcp.exposureHint")}
            value={entry.config.exposure ?? "deferred"}
            options={MCP_EXPOSURES.map((value) => ({
              value,
              label: t(`settings.nek.mcp.exposure.${value}`),
            }))}
            onCommit={actions.setExposure}
          />
          {actions.setTimeout ? (
            <SettingNumberField
              label={t("settings.nek.mcp.timeout")}
              unit="s"
              integer
              min={1}
              value={entry.config.timeout ?? MCP_DEFAULT_TIMEOUT_SECONDS}
              defaultValue={MCP_DEFAULT_TIMEOUT_SECONDS}
              onCommit={(value) =>
                actions.setTimeout?.(value === MCP_DEFAULT_TIMEOUT_SECONDS ? undefined : value) ??
                Promise.resolve()
              }
            />
          ) : null}
          {actions.setDescription ? (
            <SettingTextField
              label={t("settings.nek.mcp.form.description")}
              value={entry.config.description ?? ""}
              inputClassName="w-72"
              onCommit={actions.setDescription}
            />
          ) : null}
          <ToolList entry={entry} status={status} actions={actions} />
          <SettingRow label={t("settings.nek.mcp.actions")} description={testResult ?? undefined}>
            <div className="flex flex-wrap items-center gap-1">
              <AsyncButton
                variant="outline"
                size="sm"
                icon={<PlugIcon />}
                onClick={async () => {
                  setTestResult(null);
                  setTestResult(await actions.test());
                }}
              >
                {t("settings.nek.mcp.test")}
              </AsyncButton>
              <AsyncButton
                variant="outline"
                size="sm"
                icon={<RefreshCwIcon />}
                disabled={state === "disabled" || state === "notRunning"}
                disabledReason={t(
                  state === "disabled"
                    ? "settings.nek.mcp.reconnectDisabled"
                    : "settings.nek.mcp.notRunningHint",
                )}
                onClick={() => actions.action("reconnect")}
              >
                {t("settings.nek.mcp.reconnect")}
              </AsyncButton>
              {auth?.required ? (
                <AsyncButton
                  variant="outline"
                  size="sm"
                  icon={auth.loggedIn ? <LogOutIcon /> : <LogInIcon />}
                  onClick={() => actions.action(auth.loggedIn ? "logout" : "login")}
                >
                  {t(auth.loggedIn ? "settings.nek.mcp.logout" : "settings.nek.mcp.login")}
                </AsyncButton>
              ) : null}
              {actions.edit ? (
                <IconButton
                  size="icon-sm"
                  label={t("settings.nek.mcp.edit")}
                  onClick={actions.edit}
                >
                  <PencilIcon />
                </IconButton>
              ) : null}
              <IconButton
                size="icon-sm"
                label={t(
                  entry.isOverride ? "settings.nek.mcp.removeOverride" : "settings.nek.mcp.delete",
                )}
                onClick={actions.remove}
              >
                <Trash2Icon />
              </IconButton>
            </div>
          </SettingRow>
        </div>
      </FoldContent>
    </Fold>
  );
}
