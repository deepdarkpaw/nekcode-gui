import { useCallback, useEffect, useRef } from "react";
import type { NekBuiltinSlashInvocation } from "@zcode/shared/nek-protocol";
import { toast } from "@/components/ui/toast.js";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { executeBuiltinSlashCommand } from "./builtinSlashActions.js";

type SlashOutcome = Awaited<ReturnType<typeof executeBuiltinSlashCommand>>;
type SlashPorts = Parameters<typeof executeBuiltinSlashCommand>[2];

/** One in-flight local submission per pane. Ignore effects from a retired pane binding. */
export function useBuiltinSlashCommands(scope: object, ports: SlashPorts) {
  const { intl } = useZCodeIntl();
  const scopeRef = useRef<object | null>(scope);
  scopeRef.current = scope;
  useEffect(() => {
    scopeRef.current = scope;
    return () => {
      if (scopeRef.current === scope) scopeRef.current = null;
    };
  }, [scope]);
  const latestPorts = useRef(ports);
  latestPorts.current = ports;
  const { run } = useAsyncAction((execute: () => Promise<void>) => execute(), {
    successFeedbackMs: 0,
  });

  return useCallback(
    async (command: NekBuiltinSlashInvocation, hasAttachments = false) => {
      const isCurrent = () => scopeRef.current === scope;
      if (!isCurrent()) return "blocked";
      let outcome: SlashOutcome = { status: "blocked" };
      const completed = await run(async () => {
        try {
          outcome = await executeBuiltinSlashCommand(
            command,
            hasAttachments,
            latestPorts.current,
            isCurrent,
          );
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          outcome = {
            status: "blocked",
            notice: {
              id: "chat.slash.failed",
              values: { name: command.name, reason: reason.slice(0, 400) },
              variant: "warning",
            },
          };
        }
        if (outcome.notice && isCurrent()) {
          const { id, values, variant } = outcome.notice;
          toast(intl.formatMessage({ id }, values), { variant });
        }
      });
      if (!completed && isCurrent())
        toast(intl.formatMessage({ id: "ui.action.busy" }), { variant: "info" });
      return outcome.status;
    },
    [intl, run, scope],
  );
}
