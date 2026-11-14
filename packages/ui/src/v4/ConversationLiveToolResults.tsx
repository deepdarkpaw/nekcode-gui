import { memo, useMemo } from "react";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { Fold, FoldContent, FoldTrigger, useFoldState } from "@/components/ui/fold.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ConversationWorkWindow } from "./ConversationWorkWindow.js";

const LiveResultBody = memo(function LiveResultBody({ row }: { row: ToolCallRow }) {
  const text = useMemo(() => JSON.stringify(row.liveResult), [row.liveResult]);
  return (
    <div>
      <p className="pb-1 text-ui-xs text-foreground-subtle">{row.toolName}</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-2 text-ui-xs">
        {text}
      </pre>
    </div>
  );
});

/** Nonpersisted tool extras remain inspectable without replacing the ordinary stored output. */
export function ConversationLiveToolResults({
  rows,
  scopeKey,
}: {
  rows: readonly ConversationRow[];
  scopeKey: string;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useFoldState(`${scopeKey}:live-result`, "toolOutput", false);
  const items = useMemo(
    () =>
      rows
        .filter(
          (row): row is ToolCallRow => row.kind === "toolCall" && row.liveResult !== undefined,
        )
        .map((row) => ({ kind: "row" as const, key: `live:${row.toolCallId}`, row })),
    [rows],
  );
  if (!items.length) return null;
  return (
    <Fold
      open={open}
      onOpenChange={setOpen}
      className="mt-2 rounded-lg border border-card-border px-2 py-1"
    >
      <FoldTrigger className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "chat.history.liveToolResult" }, { count: items.length })}
      </FoldTrigger>
      <FoldContent>
        <p className="pb-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.history.liveToolResultHint" })}
        </p>
        {open ? (
          <div data-v4-timeline-scroll className="max-h-64 overflow-auto">
            <ConversationWorkWindow
              items={items}
              renderItem={(item) =>
                item.kind === "row" && item.row.kind === "toolCall" ? (
                  <LiveResultBody key={item.key} row={item.row} />
                ) : null
              }
            />
          </div>
        ) : null}
      </FoldContent>
    </Fold>
  );
}
