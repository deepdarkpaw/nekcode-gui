import { memo, useMemo } from "react";
import { ActivityIcon, SquareTerminalIcon } from "lucide-react";
import { TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER } from "@zcode/shared";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface ConversationBackgroundWorkTriggerProps {
  backgroundWorks: readonly BackgroundWorkSummary[];
  onOpen?: () => void;
}

function ConversationBackgroundWorkTriggerImpl({
  backgroundWorks,
  onOpen,
}: ConversationBackgroundWorkTriggerProps) {
  const { intl } = useZCodeIntl();
  const bashCount = useMemo(
    () =>
      backgroundWorks.filter((work) => work.status === "running" && work.kind === "bash").length,
    [backgroundWorks],
  );

  if (!onOpen || bashCount === 0) return null;

  const tooltip = intl.formatMessage({ id: "chat.composer.backgroundWorks.tooltipTerminal" });
  const ariaLabel = intl.formatMessage(
    { id: "chat.composer.backgroundWorks.ariaLabel" },
    { count: String(bashCount) },
  );

  return (
    <ControlHintTooltip title={tooltip}>
      <Button
        type="button"
        variant="ghost"
        size="default"
        data-testid={TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER}
        data-background-bash-count={bashCount}
        data-background-total-count={bashCount}
        aria-label={ariaLabel}
        onClick={onOpen}
        className="rounded-lg px-1.5 text-ui-base text-[var(--color-foreground-subtle)] tabular-nums"
      >
        <span
          data-composer-background-layout="typed"
          className="inline-flex items-center gap-1 @max-[480px]/composer:hidden"
          aria-hidden
        >
          <span className="inline-flex items-center gap-0.5">
            <SquareTerminalIcon className="size-3.5" />
            <span>{bashCount}</span>
          </span>
        </span>
        <span
          data-composer-background-layout="compact"
          className="hidden items-center gap-0.5 @max-[480px]/composer:inline-flex"
          aria-hidden
        >
          <ActivityIcon className="size-3.5" />
          <span>{bashCount}</span>
        </span>
      </Button>
    </ControlHintTooltip>
  );
}

export const ConversationBackgroundWorkTrigger = memo(ConversationBackgroundWorkTriggerImpl);
