/**
 * 服务商列表（左列）：名称、端点类型徽标、模型数、最近一次测试结果。↑ / ↓ 在列表中移动。
 * 最近测试结果保存在内存（有界，按目标 + 服务商）。
 */
import type { KeyboardEvent } from "react";
import { PlusIcon } from "lucide-react";
import { create } from "zustand";
import type { NekProviderView, NekTestProviderResult } from "@zcode/shared/nek-protocol";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposing } from "@/lib/imeComposition.js";
import { NekProviderLogo } from "../../components/NekProviderLogo.js";
import { providerApiLabel } from "./providerApi.js";

const MAX_TEST_RESULTS = 64;

interface TestResultStore {
  results: ReadonlyMap<string, NekTestProviderResult & { modelId: string }>;
  record: (key: string, result: NekTestProviderResult & { modelId: string }) => void;
}

export const useProviderTestResults = create<TestResultStore>((set) => ({
  results: new Map(),
  record: (key, result) =>
    set((state) => {
      const next = new Map(state.results);
      next.delete(key);
      next.set(key, result);
      while (next.size > MAX_TEST_RESULTS) {
        const oldest = next.keys().next().value;
        if (oldest === undefined) break;
        next.delete(oldest);
      }
      return { results: next };
    }),
}));

export function testResultKey(targetKey: string, providerId: string): string {
  return `${targetKey}::${providerId}`;
}

function TestDot({
  result,
}: {
  result: (NekTestProviderResult & { modelId: string }) | undefined;
}) {
  const { intl } = useZCodeIntl();
  if (!result) {
    return null;
  }
  const label = result.ok
    ? intl.formatMessage({ id: "settings.nek.provider.test.okShort" }, { ms: result.latencyMs })
    : intl.formatMessage({ id: "settings.nek.provider.test.failedShort" });
  return (
    <span
      className={cn("text-ui-xs", result.ok ? "text-success" : "text-destructive")}
      title={result.ok ? undefined : result.message}
    >
      {label}
    </span>
  );
}

export function ProviderList({
  providers,
  selectedId,
  targetKey,
  onSelect,
  onAdd,
}: {
  providers: readonly NekProviderView[];
  selectedId: string | undefined;
  targetKey: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const { intl } = useZCodeIntl();
  const results = useProviderTestResults((state) => state.results);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event) || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) {
      return;
    }
    const index = providers.findIndex((provider) => provider.id === selectedId);
    const next = providers[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      event.preventDefault();
      onSelect(next.id);
      requestAnimationFrame(() => document.getElementById(`nek-provider-tab-${next.id}`)?.focus());
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div
        role="listbox"
        aria-label={intl.formatMessage({ id: "settings.nek.provider.listLabel" })}
        className="flex flex-col gap-0.5"
        onKeyDown={handleKeyDown}
      >
        {providers.map((provider) => {
          const selected = provider.id === selectedId;
          const apiLabel = providerApiLabel(provider, "short", (id) => intl.formatMessage({ id }));
          return (
            <button
              key={provider.id}
              id={`nek-provider-tab-${provider.id}`}
              type="button"
              role="option"
              aria-selected={selected}
              tabIndex={selected || (!selectedId && provider === providers[0]) ? 0 : -1}
              onClick={() => onSelect(provider.id)}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused/30",
                selected ? "bg-selected" : "hover:bg-hover",
              )}
            >
              <NekProviderLogo
                hint={`${provider.id} ${provider.baseUrl}`}
                className="size-5 rounded-sm"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui-base text-foreground">
                  {provider.name ?? provider.id}
                </span>
                <span className="flex items-center gap-1.5 text-ui-xs text-foreground-subtle">
                  {apiLabel ? (
                    <>
                      <span className="truncate">{apiLabel}</span>
                      <span aria-hidden="true">·</span>
                    </>
                  ) : null}
                  <span>
                    {intl.formatMessage(
                      { id: "settings.nek.provider.modelCount" },
                      { count: provider.models.length },
                    )}
                  </span>
                </span>
              </span>
              <TestDot result={results.get(testResultKey(targetKey, provider.id))} />
            </button>
          );
        })}
      </div>
      <Button variant="outline" className="w-full" onClick={onAdd}>
        <PlusIcon aria-hidden="true" />
        {intl.formatMessage({ id: "settings.nek.provider.add" })}
      </Button>
    </div>
  );
}
