/** 草稿空态按本地时间显示问候语，到整点边界自动更新。 */
import { useEffect, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";

const GREETING_BOUNDARY_HOURS = [5, 9, 12, 14, 18, 23] as const;

type ChatEmptyGreetingMessageId =
  | "chat.empty.greeting.morningEarly"
  | "chat.empty.greeting.morning"
  | "chat.empty.greeting.noon"
  | "chat.empty.greeting.afternoon"
  | "chat.empty.greeting.evening"
  | "chat.empty.greeting.lateNight";

function getChatEmptyGreetingMessageId(date: Date = new Date()): ChatEmptyGreetingMessageId {
  const hour = date.getHours();

  if (hour >= 5 && hour < 9) return "chat.empty.greeting.morningEarly";
  if (hour >= 9 && hour < 12) return "chat.empty.greeting.morning";
  if (hour >= 12 && hour < 14) return "chat.empty.greeting.noon";
  if (hour >= 14 && hour < 18) return "chat.empty.greeting.afternoon";
  if (hour >= 18 && hour < 23) return "chat.empty.greeting.evening";

  return "chat.empty.greeting.lateNight";
}

function getNextChatEmptyGreetingDelayMs(date: Date = new Date()) {
  const candidates = GREETING_BOUNDARY_HOURS.map((hour) => {
    const boundary = new Date(date);
    boundary.setHours(hour, 0, 0, 0);
    return boundary;
  });
  const tomorrowFirstBoundary = new Date(date);
  tomorrowFirstBoundary.setDate(date.getDate() + 1);
  tomorrowFirstBoundary.setHours(GREETING_BOUNDARY_HOURS[0], 0, 0, 0);

  const nextBoundary =
    candidates.find((candidate) => candidate.getTime() > date.getTime()) ?? tomorrowFirstBoundary;

  return Math.max(1, nextBoundary.getTime() - date.getTime());
}

export function ConversationDraftEmptyState({ className }: { className?: string }) {
  const { intl } = useZCodeIntl();
  const isOfficeMode = useIsOfficeMode();
  const [greetingDate, setGreetingDate] = useState(() => new Date());
  const greeting = intl.formatMessage({
    id: isOfficeMode ? "chat.empty.greeting.office" : getChatEmptyGreetingMessageId(greetingDate),
  });

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setGreetingDate(new Date());
    }, getNextChatEmptyGreetingDelayMs(greetingDate));

    return () => {
      window.clearTimeout(timeout);
    };
  }, [greetingDate]);

  return (
    <div
      className={cn(
        "relative mb-10 flex w-full max-w-2xl flex-col items-center justify-center gap-6 text-foreground sm:mb-8",
        className,
      )}
    >
      <p
        data-v4-draft-greeting="true"
        className="relative z-10 w-full px-4 text-center text-ui-xl/[1.2] font-medium text-foreground"
      >
        {greeting}
      </p>
    </div>
  );
}
