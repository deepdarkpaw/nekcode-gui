/**
 * 从本机复制到此主机：勾选服务商、OAuth 登录（默认不勾选，并提示刷新令牌轮换风险）、
 * 可选的 MCP / 默认模型 / 压缩设置；预览后同名项逐个选择覆盖或跳过。
 */
import { useEffect, useState } from "react";
import { AlertTriangleIcon, LoaderIcon } from "lucide-react";
import type { NekConfigTarget, NekCopyPreview, NekCopySelection } from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useFocusRestore } from "@/hooks/useFocusRestore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { LOCAL_TARGET, useNekConfigApi } from "../../api/NekSettingsContext.js";
import { toNekConfigApiError } from "../../api/nekErrors.js";
import { Segmented } from "../../components/inputs.js";

interface Sources {
  providers: Array<{ id: string; name: string }>;
  logins: Array<{ id: string; name: string }>;
  mcpServers: string[];
}

function useLocalSources(open: boolean) {
  const api = useNekConfigApi();
  const [sources, setSources] = useState<Sources | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setSources(null);
    setError(null);
    Promise.all([
      api.readModelsConfig(LOCAL_TARGET),
      api.getAuthStatus(LOCAL_TARGET),
      api.readMcpConfig(LOCAL_TARGET, "global"),
    ]).then(
      ([models, auth, mcp]) =>
        !cancelled &&
        setSources({
          providers: models.providers.map((provider) => ({
            id: provider.id,
            name: provider.name ?? provider.id,
          })),
          logins: auth
            .filter((status) => status.kind === "oauth")
            .map((status) => ({ id: status.provider, name: status.name })),
          mcpServers: mcp.servers.map((server) => server.name),
        }),
      (cause: unknown) => !cancelled && setError(toNekConfigApiError(cause).message),
    );
    return () => {
      cancelled = true;
    };
  }, [open, api]);
  return { sources, error };
}

export function copyItemKey(item: { kind: string; id: string }): string {
  return `${item.kind}:${item.id}`;
}

function toggle(list: readonly string[], id: string, on: boolean): string[] {
  return on ? [...list.filter((item) => item !== id), id] : list.filter((item) => item !== id);
}

function CheckRow({
  label,
  checked,
  onChange,
  mono,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  mono?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md px-1 py-0.5 text-ui-sm hover:bg-hover">
      <Checkbox checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      <span className={mono ? "font-mono" : undefined}>{label}</span>
    </label>
  );
}

export function CopyToHostDialog({
  open,
  onOpenChange,
  target,
  hostLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: NekConfigTarget;
  hostLabel: string;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const api = useNekConfigApi();
  const focusRestore = useFocusRestore(open);
  const { sources, error } = useLocalSources(open);
  const [selection, setSelection] = useState<NekCopySelection>({
    providers: [],
    logins: [],
    mcpServers: [],
    defaults: false,
    compaction: false,
  });
  const [preview, setPreview] = useState<NekCopyPreview | null>(null);
  const [resolution, setResolution] = useState<Record<string, "overwrite" | "skip">>({});
  useEffect(() => {
    if (sources) {
      // 服务商默认全选；OAuth 登录默认不勾选；MCP / 默认模型 / 压缩可选。
      setSelection({
        providers: sources.providers.map((p) => p.id),
        logins: [],
        mcpServers: [],
        defaults: false,
        compaction: false,
      });
      setPreview(null);
      setResolution({});
    }
  }, [sources]);
  const update = (patch: Partial<NekCopySelection>) => {
    setSelection((current) => ({ ...current, ...patch }));
    setPreview(null);
  };
  const count =
    selection.providers.length +
    selection.logins.length +
    selection.mcpServers.length +
    Number(selection.defaults) +
    Number(selection.compaction);
  const copyCount = preview
    ? preview.items.filter(
        (item) => !item.conflict || resolution[copyItemKey(item)] === "overwrite",
      ).length
    : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl"
        onCloseAutoFocus={focusRestore.onCloseAutoFocus}
      >
        <DialogHeader className="pr-8">
          <DialogTitle>{t("settings.nek.copy.title", { host: hostLabel })}</DialogTitle>
          <DialogDescription>{t("settings.nek.copy.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
          {!sources && !error ? (
            <p role="status" className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
              <LoaderIcon className="size-3.5 animate-spin" aria-hidden="true" />
              {t("settings.nek.load.loading")}
            </p>
          ) : null}
          {sources && !preview ? (
            <>
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-ui-sm font-medium">
                  {t("settings.nek.copy.providers")}
                </legend>
                {sources.providers.map((provider) => (
                  <CheckRow
                    key={provider.id}
                    label={`${provider.name} (${provider.id})`}
                    checked={selection.providers.includes(provider.id)}
                    onChange={(on) =>
                      update({ providers: toggle(selection.providers, provider.id, on) })
                    }
                  />
                ))}
              </fieldset>
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-ui-sm font-medium">
                  {t("settings.nek.copy.logins")}
                </legend>
                <p className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-ui-sm text-foreground">
                  <AlertTriangleIcon
                    className="mt-0.5 size-3.5 shrink-0 text-warning"
                    aria-hidden="true"
                  />
                  {t("settings.nek.copy.oauthWarning")}
                </p>
                {sources.logins.length === 0 ? (
                  <p className="text-ui-sm text-foreground-subtlest">
                    {t("settings.nek.copy.noLogins")}
                  </p>
                ) : null}
                {sources.logins.map((login) => (
                  <CheckRow
                    key={login.id}
                    label={login.name}
                    checked={selection.logins.includes(login.id)}
                    onChange={(on) => update({ logins: toggle(selection.logins, login.id, on) })}
                  />
                ))}
              </fieldset>
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-ui-sm font-medium">
                  {t("settings.nek.copy.optional")}
                </legend>
                {sources.mcpServers.map((name) => (
                  <CheckRow
                    key={name}
                    mono
                    label={name}
                    checked={selection.mcpServers.includes(name)}
                    onChange={(on) =>
                      update({ mcpServers: toggle(selection.mcpServers, name, on) })
                    }
                  />
                ))}
                <CheckRow
                  label={t("settings.nek.copy.defaults")}
                  checked={selection.defaults}
                  onChange={(defaults) => update({ defaults })}
                />
                <CheckRow
                  label={t("settings.nek.copy.compaction")}
                  checked={selection.compaction}
                  onChange={(compaction) => update({ compaction })}
                />
              </fieldset>
            </>
          ) : null}
          {preview ? (
            <ul
              aria-label={t("settings.nek.copy.previewLabel")}
              className="flex flex-col gap-1 rounded-xl border border-card-border bg-card p-2"
            >
              {preview.items.map((item) => (
                <li key={copyItemKey(item)} className="flex flex-wrap items-center gap-2 px-2 py-1">
                  <span className="rounded-sm bg-tag px-1 text-ui-xs text-foreground-subtle">
                    {t(`settings.nek.copy.kind.${item.kind}`)}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-ui-sm">{item.id}</span>
                  {item.conflict ? (
                    <Segmented<"overwrite" | "skip">
                      ariaLabel={t("settings.nek.copy.conflictLabel", { id: item.id })}
                      value={resolution[copyItemKey(item)] ?? "skip"}
                      options={[
                        { value: "skip", label: t("settings.nek.copy.skip") },
                        { value: "overwrite", label: t("settings.nek.copy.overwrite") },
                      ]}
                      onChange={(value) =>
                        setResolution((current) => ({ ...current, [copyItemKey(item)]: value }))
                      }
                    />
                  ) : (
                    <span className="text-ui-xs text-success">{t("settings.nek.copy.new")}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <DialogFooter>
          {preview ? (
            <Button variant="ghost" className="sm:mr-auto" onClick={() => setPreview(null)}>
              {t("settings.nek.copy.back")}
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          {preview ? (
            <AsyncButton
              disabled={copyCount === 0}
              disabledReason={t("settings.nek.copy.nothing")}
              successFeedback="none"
              onClick={async () => {
                const full = Object.fromEntries(
                  preview.items
                    .filter((item) => item.conflict)
                    .map((item) => [copyItemKey(item), resolution[copyItemKey(item)] ?? "skip"]),
                );
                await api.copy(LOCAL_TARGET, target, selection, full);
                toast(t("settings.nek.copy.done", { count: copyCount, host: hostLabel }));
                onOpenChange(false);
              }}
            >
              {t("settings.nek.copy.confirm", { count: copyCount })}
            </AsyncButton>
          ) : (
            <AsyncButton
              disabled={count === 0}
              disabledReason={t("settings.nek.copy.nothing")}
              successFeedback="none"
              onClick={async () =>
                setPreview(await api.previewCopy(LOCAL_TARGET, target, selection))
              }
            >
              {t("settings.nek.copy.preview", { count })}
            </AsyncButton>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
