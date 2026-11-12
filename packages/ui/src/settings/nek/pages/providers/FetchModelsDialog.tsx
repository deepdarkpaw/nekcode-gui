/**
 * 获取模型列表：搜索、全选 / 全不选；每行显示元数据来源（接口返回 / 内置目录 / 默认值）；
 * 已添加的模型勾选且不可操作；主按钮写明数量"添加 N 个模型"。
 * 401/403 → "Key 无效或无权限"；404 → "该地址不提供模型列表接口" + [手动添加]。
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { analyzeBaseUrl } from "../../lib/baseUrl.js";
import { ModelImportEndpoints } from "./ModelImportEndpoints.js";
import { ImageIcon, LoaderIcon, PencilLineIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import type { NekModelConfig, NekProviderView } from "@zcode/shared/nek-protocol";
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
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useFocusRestore } from "@/hooks/useFocusRestore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatTokens } from "@/lib/displayFormat.js";
import { useNekConfigApi, useNekTarget } from "../../api/NekSettingsContext.js";
import { toNekConfigApiError } from "../../api/nekErrors.js";
import {
  classifyFetchError,
  filterFetchedModels,
  mergeFetchedModels,
  modelConfigFromRow,
  type FetchErrorKind,
  type FetchedModelRow,
} from "../../lib/fetchedModels.js";
import { ThinkingLevelBadges } from "../../components/modelControls.js";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; rows: FetchedModelRow[]; endpoint: string }
  | { status: "error"; kind: FetchErrorKind; message: string; endpoint?: string };

const SOURCE_CLASSNAME: Record<FetchedModelRow["source"], string> = {
  api: "bg-success/15 text-success",
  catalog: "bg-icon-blue/15 text-icon-blue",
  default: "bg-tag text-foreground-subtle",
};

function useFetchedModels(open: boolean, provider: NekProviderView, attempt: number): LoadState {
  const api = useNekConfigApi();
  const { target } = useNekTarget();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    let cancelled = false;
    setState({ status: "loading" });
    const existing = new Set(provider.models.map((model) => model.id));
    void (async () => {
      try {
        const result = await api.fetchProviderModels(target, { providerId: provider.id });
        if (!result.ok) {
          if (!cancelled) {
            setState({
              status: "error",
              kind: classifyFetchError(result),
              message: result.message,
              endpoint: result.endpoint,
            });
          }
          return;
        }
        const catalog = await api.getModelCatalog(
          target,
          result.models.map((model) => model.id),
        );
        if (!cancelled) {
          setState({
            status: "ready",
            rows: mergeFetchedModels(result.models, catalog, existing),
            endpoint: result.endpoint,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({ status: "error", kind: "other", message: toNekConfigApiError(error).message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, api, target, provider, attempt]);
  return state;
}

function ModelRow({
  row,
  checked,
  onToggle,
}: {
  row: FetchedModelRow;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const id = `nek-fetch-${row.id}`;
  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-md px-2 py-1.5",
        !row.alreadyAdded && "hover:bg-hover",
      )}
    >
      <Checkbox
        id={id}
        data-nek-fetch-row=""
        checked={row.alreadyAdded || checked}
        disabled={row.alreadyAdded}
        onCheckedChange={(next) => onToggle(next === true)}
      />
      <label
        htmlFor={id}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-3",
          row.alreadyAdded ? "opacity-60" : "cursor-pointer",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-ui-sm text-foreground">{row.id}</span>
          {row.name && row.name !== row.id ? (
            <span className="truncate text-ui-xs text-foreground-subtle">{row.name}</span>
          ) : null}
        </span>
        <span className="shrink-0 font-mono text-ui-xs text-foreground-subtle">
          {formatTokens(row.contextWindow)} / {formatTokens(row.maxTokens)}
        </span>
        {row.input.includes("image") ? (
          <ImageIcon
            className="size-3.5 text-foreground-subtle"
            aria-label={intl.formatMessage({ id: "settings.nek.model.imageInput" })}
          />
        ) : null}
        {row.reasoning ? <ThinkingLevelBadges levels={row.thinkingLevels.slice(0, 3)} /> : null}
        <span
          className={cn(
            "shrink-0 rounded-sm px-1.5 text-ui-xs leading-5",
            SOURCE_CLASSNAME[row.source],
          )}
        >
          {intl.formatMessage({ id: `settings.nek.fetch.source.${row.source}` })}
        </span>
        {row.alreadyAdded ? (
          <span className="shrink-0 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "settings.nek.fetch.added" })}
          </span>
        ) : null}
      </label>
    </li>
  );
}

/** ↑ / ↓ 在复选框之间移动焦点。 */
function handleListKeyDown(event: KeyboardEvent<HTMLUListElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  const boxes = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>("[data-nek-fetch-row]:not([disabled])"),
  );
  const index = boxes.indexOf(document.activeElement as HTMLElement);
  const next = boxes[index + (event.key === "ArrowDown" ? 1 : -1)];
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

export function FetchModelsDialog({
  open,
  onOpenChange,
  provider,
  onAdd,
  onManualAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: NekProviderView;
  onAdd: (models: NekModelConfig[]) => Promise<void>;
  onManualAdd: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const focusRestore = useFocusRestore(open);
  const [attempt, setAttempt] = useState(0);
  const state = useFetchedModels(open, provider, attempt);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [importApi, setImportApi] = useState("");
  const [importBaseUrl, setImportBaseUrl] = useState("");
  const baseUrlMissing =
    !importBaseUrl.trim() && !provider.baseUrl.trim() && !provider.overridesBuiltin;
  const baseUrlInvalid =
    Boolean(importBaseUrl.trim()) &&
    analyzeBaseUrl("openai-completions", importBaseUrl).kind === "invalid";
  const canInheritApi = Boolean(provider.api.trim()) || provider.overridesBuiltin;
  const apiRequired = !canInheritApi && !importApi;
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(new Set());
      setImportApi("");
      setImportBaseUrl("");
    }
  }, [open, provider.id]);

  const rows = state.status === "ready" ? state.rows : [];
  const visible = useMemo(() => filterFetchedModels(rows, query), [rows, query]);
  const selectable = visible.filter((row) => !row.alreadyAdded);
  const chosen = rows.filter((row) => !row.alreadyAdded && selected.has(row.id));
  const setMany = (ids: string[], checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid-rows-[auto_auto_minmax(0,1fr)_auto] sm:max-w-2xl max-h-[calc(100vh-2rem)]"
        onCloseAutoFocus={focusRestore.onCloseAutoFocus}
      >
        <DialogHeader className="pr-8">
          <DialogTitle>
            {t("settings.nek.fetch.title", { provider: provider.name ?? provider.id })}
          </DialogTitle>
          <DialogDescription>{t("settings.nek.fetch.description")}</DialogDescription>
        </DialogHeader>
        {state.status === "ready" ? (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-foreground-subtlest"
                aria-hidden="true"
              />
              <Input
                autoFocus
                value={query}
                aria-label={t("settings.nek.fetch.search")}
                placeholder={t("settings.nek.fetch.search")}
                className="pl-7"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={selectable.length === 0}
              onClick={() =>
                setMany(
                  selectable.map((row) => row.id),
                  true,
                )
              }
            >
              {t("settings.nek.fetch.selectAll")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={selectable.length === 0}
              onClick={() =>
                setMany(
                  selectable.map((row) => row.id),
                  false,
                )
              }
            >
              {t("settings.nek.fetch.selectNone")}
            </Button>
          </div>
        ) : (
          <div />
        )}
        <div className="min-h-0 overflow-y-auto">
          {state.status === "ready" ? (
            <ModelImportEndpoints
              provider={provider}
              api={importApi}
              baseUrl={importBaseUrl}
              baseUrlInvalid={baseUrlInvalid}
              onApiChange={setImportApi}
              onBaseUrlChange={setImportBaseUrl}
            />
          ) : null}
          {state.status === "loading" ? (
            <p
              role="status"
              className="flex items-center gap-2 py-8 text-ui-base text-foreground-subtle"
            >
              <LoaderIcon className="size-4 animate-spin" aria-hidden="true" />
              {t("settings.nek.fetch.loading")}
            </p>
          ) : null}
          {state.status === "error" ? (
            <div role="alert" className="flex flex-col gap-2 py-4">
              <p className="text-ui-base font-medium text-destructive">
                {t(`settings.nek.fetch.error.${state.kind}`)}
              </p>
              <p className="text-ui-sm text-foreground-subtle">{state.message}</p>
              {state.endpoint ? (
                <p className="font-mono text-ui-xs text-foreground-subtlest">{state.endpoint}</p>
              ) : null}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  <RefreshCwIcon aria-hidden="true" />
                  {t("settings.nek.load.retry")}
                </Button>
                {state.kind === "notFound" ? (
                  <Button variant="secondary" size="sm" onClick={onManualAdd}>
                    <PencilLineIcon aria-hidden="true" />
                    {t("settings.nek.fetch.manualAdd")}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          {state.status === "ready" && visible.length === 0 ? (
            <p className="py-6 text-ui-base text-foreground-subtle">
              {t("settings.nek.fetch.empty")}
            </p>
          ) : null}
          {state.status === "ready" && visible.length > 0 ? (
            <ul
              aria-label={t("settings.nek.fetch.listLabel")}
              className="flex flex-col gap-0.5"
              onKeyDown={handleListKeyDown}
            >
              {visible.map((row) => (
                <ModelRow
                  key={row.id}
                  row={row}
                  checked={selected.has(row.id)}
                  onToggle={(checked) => setMany([row.id], checked)}
                />
              ))}
            </ul>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <AsyncButton
            disabled={chosen.length === 0 || apiRequired || baseUrlMissing || baseUrlInvalid}
            disabledReason={t(
              apiRequired
                ? "settings.nek.modelEditor.error.apiRequired"
                : baseUrlMissing
                  ? "settings.nek.provider.error.baseUrlRequired"
                  : baseUrlInvalid
                    ? "settings.nek.provider.error.baseUrlInvalid"
                    : "settings.nek.fetch.noneSelected",
            )}
            successFeedback="none"
            onClick={async () => {
              if (apiRequired || baseUrlMissing || baseUrlInvalid) return;
              await onAdd(
                chosen.map((row) => modelConfigFromRow(row, importApi, importBaseUrl.trim())),
              );
              onOpenChange(false);
            }}
          >
            {t("settings.nek.fetch.add", { count: chosen.length })}
          </AsyncButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
