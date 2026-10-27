/**
 * 从本机复制到此主机：勾选服务商、OAuth 登录（默认不勾选，并提示刷新令牌轮换风险）、
 * 可选的 MCP / 默认模型 / 压缩设置；预览后同名项逐个选择覆盖或跳过。
 */
import { useEffect, useState } from "react";
import { AlertTriangleIcon, CheckIcon, LoaderIcon, MinusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import type {
  NekConfigTarget,
  NekCopyItemResult,
  NekCopyPreview,
  NekCopyResolution,
  NekCopyResult,
  NekCopySelection,
} from "@zcode/shared/nek-protocol";
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

/** `<kind>:<id>` → 展示用的两段；id 里允许出现冒号，所以只切第一个。 */
export function parseCopyItemKey(key: string): { kind: string; id: string } {
  const index = key.indexOf(":");
  return index < 0 ? { kind: key, id: "" } : { kind: key.slice(0, index), id: key.slice(index + 1) };
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

/** 逐项结果：成功 / 跳过 / 失败（失败给出原因，可整批重试）。 */
function CopyResults({ result }: { result: NekCopyResult }) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const counts = {
    copied: result.items.filter((item) => item.status === "copied").length,
    skipped: result.items.filter((item) => item.status === "skipped").length,
    failed: result.items.filter((item) => item.status === "failed").length,
  };
  const iconOf = (item: NekCopyItemResult) =>
    item.status === "copied" ? (
      <CheckIcon className="size-3.5 text-success" aria-hidden="true" />
    ) : item.status === "skipped" ? (
      <MinusIcon className="size-3.5 text-foreground-subtlest" aria-hidden="true" />
    ) : (
      <XIcon className="size-3.5 text-destructive" aria-hidden="true" />
    );
  return (
    <div className="flex flex-col gap-2">
      <p role="status" className="text-ui-sm text-foreground">
        {t("settings.nek.copy.resultSummary", counts)}
      </p>
      <ul
        aria-label={t("settings.nek.copy.resultLabel")}
        className="flex flex-col gap-1 rounded-xl border border-card-border bg-card p-2"
      >
        {result.items.map((item) => {
          const parsed = parseCopyItemKey(item.key);
          return (
            <li key={item.key} className="flex flex-wrap items-start gap-2 px-2 py-1">
              {iconOf(item)}
              <span className="rounded-sm bg-tag px-1 text-ui-xs text-foreground-subtle">
                {t(`settings.nek.copy.kind.${parsed.kind}`)}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-ui-sm">{parsed.id}</span>
              <span className="text-ui-xs text-foreground-subtle">
                {t(`settings.nek.copy.status.${item.status}`)}
              </span>
              {item.error ? (
                <span className="w-full text-ui-xs text-destructive">{item.error}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
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
  const [result, setResult] = useState<NekCopyResult | null>(null);

  const runCopy = async (full: NekCopyResolution) => {
    const outcome = await api.copy(LOCAL_TARGET, target, selection, full);
    setResult(outcome);
    const failed = outcome.items.filter((item) => item.status === "failed").length;
    const copied = outcome.items.filter((item) => item.status === "copied").length;
    if (failed > 0) {
      toast(t("settings.nek.copy.partial", { failed, host: hostLabel }), { variant: "warning" });
      return;
    }
    toast(t("settings.nek.copy.done", { count: copied, host: hostLabel }));
    onOpenChange(false);
  };

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
      setResult(null);
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
  /** 本次复制用到的决议（失败重试沿用同一份）。 */
  const resolutionOf = (): NekCopyResolution =>
    Object.fromEntries(
      (preview?.items ?? [])
        .filter((item) => item.conflict)
        .map((item) => [copyItemKey(item), resolution[copyItemKey(item)] ?? "skip"]),
    );

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
          {sources && !preview && !result ? (
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
          {result ? <CopyResults result={result} /> : null}
        </div>
        <DialogFooter>
          {preview && !result ? (
            <Button variant="ghost" className="sm:mr-auto" onClick={() => setPreview(null)}>
              {t("settings.nek.copy.back")}
            </Button>
          ) : null}
          {result ? (
            <>
              <Button variant="ghost" className="sm:mr-auto" onClick={() => setResult(null)}>
                {t("settings.nek.copy.back")}
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.close")}
              </Button>
              {result.items.some((item) => item.status === "failed") ? (
                <AsyncButton
                  successFeedback="none"
                  icon={<RefreshCwIcon />}
                  onClick={() => runCopy(resolutionOf())}
                >
                  {t("settings.nek.copy.retryFailed")}
                </AsyncButton>
              ) : null}
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              {preview ? (
                <AsyncButton
                  disabled={copyCount === 0}
                  disabledReason={t("settings.nek.copy.nothing")}
                  successFeedback="none"
                  onClick={() => runCopy(resolutionOf())}
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
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
