/**
 * 服务商详情（右列）：概要、测试连接（选模型 → 耗时或错误原因）、获取模型列表、编辑、
 * 更多（修改 ID / 删除服务商）、模型表格。
 */
import { useState } from "react";
import { DownloadCloudIcon, EllipsisIcon, PencilIcon, PlusIcon, ZapIcon } from "lucide-react";
import type { NekModelConfig, NekProviderView } from "@zcode/shared/nek-protocol";
import { NEK_ENDPOINT_APIS } from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { IconButton } from "@/components/ui/icon-button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNekConfigApi, useNekTarget } from "../../api/NekSettingsContext.js";
import { NekProviderLogo } from "../../components/NekProviderLogo.js";
import { NekEmptyState } from "../../components/DocumentStatus.js";
import { ModelTable } from "./ModelTable.js";
import { testResultKey, useProviderTestResults } from "./ProviderList.js";

export function apiLabelId(api: string): string | null {
  return (NEK_ENDPOINT_APIS as readonly string[]).includes(api)
    ? `settings.nek.provider.api.${api}`
    : null;
}

function KeySummary({ provider }: { provider: NekProviderView }) {
  const { intl } = useZCodeIntl();
  const key = provider.apiKey;
  const text =
    key.kind === "literal"
      ? key.masked
      : key.kind === "env"
        ? `$${key.name}`
        : key.kind === "command"
          ? `!${key.command}`
          : intl.formatMessage({ id: "settings.nek.provider.noKey" });
  return <span className="font-mono">{text}</span>;
}

function TestConnection({ provider }: { provider: NekProviderView }) {
  const { intl } = useZCodeIntl();
  const api = useNekConfigApi();
  const { target, targetKey } = useNekTarget();
  const resultKey = testResultKey(targetKey, provider.id);
  const result = useProviderTestResults((state) => state.results.get(resultKey));
  const record = useProviderTestResults((state) => state.record);
  const [modelId, setModelId] = useState<string | undefined>(provider.models[0]?.id);
  const selected = provider.models.some((model) => model.id === modelId)
    ? modelId
    : provider.models[0]?.id;
  const run = async () => {
    if (!selected) return;
    const outcome = await api.testProvider(target, { providerId: provider.id }, selected);
    record(resultKey, { ...outcome, modelId: selected });
    if (!outcome.ok) {
      throw new Error(outcome.status ? `${outcome.status} · ${outcome.message}` : outcome.message);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Select value={selected} onValueChange={setModelId} disabled={provider.models.length === 0}>
          <SelectTrigger
            className="w-56"
            aria-label={intl.formatMessage({ id: "settings.nek.provider.test.model" })}
          >
            <SelectValue
              placeholder={intl.formatMessage({ id: "settings.nek.provider.test.noModels" })}
            />
          </SelectTrigger>
          <SelectContent>
            {provider.models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                <span className="font-mono">{model.id}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <AsyncButton
          variant="outline"
          icon={<ZapIcon />}
          disabled={!selected}
          disabledReason={intl.formatMessage({ id: "settings.nek.provider.test.needModel" })}
          onClick={run}
        >
          {intl.formatMessage({ id: "settings.nek.provider.test.run" })}
        </AsyncButton>
      </div>
      {result && result.modelId === selected ? (
        <p
          role="status"
          className={cn("text-ui-sm", result.ok ? "text-success" : "text-destructive")}
        >
          {result.ok
            ? intl.formatMessage({ id: "settings.nek.provider.test.ok" }, { ms: result.latencyMs })
            : intl.formatMessage(
                {
                  id:
                    result.status === 401 || result.status === 403
                      ? "settings.nek.fetch.error.auth"
                      : "settings.nek.provider.test.failed",
                },
                { reason: result.message },
              )}
        </p>
      ) : null}
    </div>
  );
}

export function ProviderDetail({
  provider,
  defaultModelRef,
  onEdit,
  onFetch,
  onRename,
  onDelete,
  onAddModel,
  onEditModel,
  onSetDefault,
  onDeleteModel,
  onReorder,
}: {
  provider: NekProviderView;
  defaultModelRef: { provider?: string; model?: string };
  onEdit: () => void;
  onFetch: () => void;
  onRename: () => void;
  onDelete: () => void;
  onAddModel: () => void;
  onEditModel: (model: NekModelConfig) => void;
  onSetDefault: (model: NekModelConfig) => void;
  onDeleteModel: (model: NekModelConfig) => void;
  onReorder: (ids: string[]) => void;
}) {
  const { intl } = useZCodeIntl();
  const labelId = apiLabelId(provider.api);
  return (
    <section
      aria-labelledby="nek-provider-detail-title"
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-card-border bg-card p-4"
    >
      <header className="flex items-start gap-3">
        <NekProviderLogo
          hint={`${provider.id} ${provider.baseUrl}`}
          className="size-8 rounded-lg"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h3
            id="nek-provider-detail-title"
            className="truncate text-ui-lg font-medium text-foreground"
          >
            {provider.name ?? provider.id}
          </h3>
          <p className="flex flex-wrap items-center gap-x-2 text-ui-sm text-foreground-subtle">
            <span className="font-mono">{provider.id}</span>
            <span aria-hidden="true">·</span>
            <span>{labelId ? intl.formatMessage({ id: labelId }) : provider.api}</span>
            {provider.overridesBuiltin ? (
              <span className="rounded-sm bg-tag px-1 text-ui-xs">
                {intl.formatMessage({ id: "settings.nek.provider.overridesBuiltin" })}
              </span>
            ) : null}
          </p>
          <p className="break-all font-mono text-ui-sm text-foreground-subtle">
            {provider.baseUrl}
          </p>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.nek.provider.field.apiKey" })}:{" "}
            <KeySummary provider={provider} />
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" onClick={onEdit}>
            <PencilIcon aria-hidden="true" />
            {intl.formatMessage({ id: "settings.nek.provider.edit" })}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={intl.formatMessage({ id: "settings.nek.provider.more" })}>
                <EllipsisIcon />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onRename}>
                {intl.formatMessage({ id: "settings.nek.provider.renameId" })}
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                {intl.formatMessage({ id: "settings.nek.provider.delete.confirm" })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <TestConnection key={provider.id} provider={provider} />
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage(
            { id: "settings.nek.model.title" },
            { count: provider.models.length },
          )}
        </h4>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onAddModel}>
            <PlusIcon aria-hidden="true" />
            {intl.formatMessage({ id: "settings.nek.model.addManual" })}
          </Button>
          <Button onClick={onFetch}>
            <DownloadCloudIcon aria-hidden="true" />
            {intl.formatMessage({ id: "settings.nek.provider.fetchModels" })}
          </Button>
        </div>
      </div>
      {provider.models.length === 0 ? (
        <NekEmptyState
          title={intl.formatMessage({ id: "settings.nek.model.emptyTitle" })}
          description={intl.formatMessage({ id: "settings.nek.model.emptyDescription" })}
          action={
            <Button variant="outline" onClick={onFetch}>
              {intl.formatMessage({ id: "settings.nek.provider.fetchModels" })}
            </Button>
          }
        />
      ) : (
        <ModelTable
          provider={provider}
          defaultModelId={
            defaultModelRef.provider === provider.id ? defaultModelRef.model : undefined
          }
          onEdit={onEditModel}
          onSetDefault={onSetDefault}
          onDelete={onDeleteModel}
          onReorder={onReorder}
        />
      )}
    </section>
  );
}
