/**
 * 复制到远程的逐项结果：成功 / 跳过 / 失败（失败给出原因，可整批重试）。
 */
import { CheckIcon, MinusIcon, XIcon } from "lucide-react";
import type { NekCopyItemResult, NekCopyResult } from "@zcode/shared/nek-protocol";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** `<kind>:<id>` → 展示用的两段；id 里允许出现冒号，所以只切第一个。 */
function parseCopyItemKey(key: string): { kind: string; id: string } {
  const index = key.indexOf(":");
  return index < 0
    ? { kind: key, id: "" }
    : { kind: key.slice(0, index), id: key.slice(index + 1) };
}

export function CopyResults({ result }: { result: NekCopyResult }) {
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
