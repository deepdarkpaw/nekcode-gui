/**
 * 写盘后的自动 reload 结果通知。
 *
 * 为什么需要它：写盘成功只说明文件写对了；`reload` 还要让目标机器上的 nek 进程重新读配置。
 * 进程起不来、RPC 超时这类**进程级失败**不该静默吞掉（否则用户以为新配置已生效），
 * 所以以 toast 提示并提供"重试"；配置内容本身的问题仍在各页面的 DiagnosticsList 里显示。
 */
import { useEffect, useRef } from "react";
import type { NekSessionReloadOutcome } from "@zcode/shared/nek-protocol";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNekConfigApi, useNekTarget } from "./NekSettingsContext.js";
import { toNekConfigApiError } from "./nekErrors.js";

const RELOAD_TOAST_MS = 8000;

export function useNekReloadNotifications(): void {
  const api = useNekConfigApi();
  const { target, targetKey } = useNekTarget();
  const { intl } = useZCodeIntl();
  const targetRef = useRef(target);
  targetRef.current = target;
  const intlRef = useRef(intl);
  intlRef.current = intl;

  useEffect(() => {
    const t = (id: string, values?: Record<string, string | number>) =>
      intlRef.current.formatMessage({ id }, values);
    const report = (outcome: NekSessionReloadOutcome) => {
      if (outcome.failures.length === 0) return false;
      toast(
        t("settings.nek.reload.failed", {
          count: outcome.failures.length,
          reason: outcome.failures[0]?.message ?? "",
        }),
        {
          variant: "warning",
          durationMs: RELOAD_TOAST_MS,
          dedupeKey: "nek-reload-failure",
          actionLabel: t("settings.nek.reload.retry"),
          onAction: () => {
            void api
              .reloadRunningSessions(targetRef.current)
              .then((retried) => {
                if (!report(retried)) {
                  toast(t("settings.nek.reload.recovered"), { variant: "info" });
                }
              })
              .catch((error: unknown) => {
                toast(toNekConfigApiError(error).message, { variant: "warning" });
              });
          },
        },
      );
      return true;
    };
    return api.onReloadResult(targetRef.current, report);
  }, [api, targetKey]);
}
