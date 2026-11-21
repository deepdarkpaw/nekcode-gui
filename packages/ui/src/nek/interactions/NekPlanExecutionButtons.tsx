import { useRef, useState } from "react";
import { AsyncButton } from "@/components/ui/async-button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function NekPlanExecutionButtons({
  execute,
}: {
  execute: (fresh: boolean) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<boolean | null>(null);
  const run = async (fresh: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(fresh);
    try {
      await execute(fresh);
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-wrap justify-end gap-2 border-t border-card-border px-4 py-2">
      {([true, false] as const).map((fresh) => (
        <AsyncButton
          key={String(fresh)}
          type="button"
          size="sm"
          variant={fresh ? "secondary" : "default"}
          disabled={busy !== null && busy !== fresh}
          disabledReason={busy !== null ? intl.formatMessage({ id: "ui.action.busy" }) : undefined}
          successFeedback="none"
          onClick={(event) => {
            event.stopPropagation();
            return run(fresh);
          }}
        >
          {intl.formatMessage({
            id: fresh ? "nek.interaction.plan.implementFresh" : "nek.interaction.plan.implement",
          })}
        </AsyncButton>
      ))}
    </div>
  );
}
