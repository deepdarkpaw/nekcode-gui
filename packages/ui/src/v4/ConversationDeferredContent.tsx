import { useEffect, useRef, useState } from "react";
import type { HistoryContentReference } from "@zcode/shared/zcode-protocol-v4";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Fold, FoldContent, FoldTrigger } from "@/components/ui/fold.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes } from "@/lib/displayFormat.js";
import type { ConversationHistoryControls } from "./useConversationHistoryControls.js";

const CHUNK_BYTES = 64 * 1024;

/** One opt-in chunk is retained, not an assembled copy of an arbitrarily large historical value. */
export function ConversationDeferredContent({
  reference,
  read,
}: {
  reference: HistoryContentReference;
  read?: ConversationHistoryControls["readContent"];
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [chunk, setChunk] = useState<{
    offset: number;
    end: number;
    text: string;
    next?: number;
  }>();
  const [loading, setLoading] = useState(false);
  const flight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const load = async (offset: number) => {
    if (!read || flight.current) return;
    flight.current = true;
    setLoading(true);
    try {
      const result = await read({ ref: reference.ref, offset, limit: CHUNK_BYTES });
      if (!alive.current) return;
      if (
        result.ref !== reference.ref ||
        result.offset !== offset ||
        result.totalBytes !== reference.totalBytes ||
        result.data.length > Math.ceil(CHUNK_BYTES / 3) * 4
      )
        throw new Error("Invalid history content slice");
      const bytes = Uint8Array.from(atob(result.data), (value) => value.charCodeAt(0));
      if (
        bytes.length > CHUNK_BYTES ||
        offset + bytes.length !== (result.nextOffset ?? result.totalBytes) ||
        (result.nextOffset !== undefined &&
          (result.nextOffset <= offset || result.nextOffset > result.totalBytes))
      )
        throw new Error("History content cursor did not advance");
      let text = new TextDecoder().decode(bytes);
      if (offset === 0 && result.nextOffset === undefined) {
        const value: unknown = JSON.parse(text);
        if (typeof value === "string") text = value;
      }
      setChunk({ offset, end: offset + bytes.length, text, next: result.nextOffset });
      setOpen(true);
    } finally {
      flight.current = false;
      if (alive.current) setLoading(false);
    }
  };
  const label = intl.formatMessage(
    { id: "chat.history.deferredContent" },
    { size: formatBytes(reference.totalBytes) },
  );
  const loadingLabel = intl.formatMessage({ id: "chat.message.bodyPreview.loading" });
  if (!read) return <p className="text-ui-sm text-foreground-subtle">{label}</p>;
  return (
    <Fold open={open} onOpenChange={setOpen} className="rounded-lg border border-border p-2">
      {chunk ? (
        <FoldTrigger>{label}</FoldTrigger>
      ) : (
        <AsyncButton variant="ghost" size="xs" successFeedback="none" onClick={() => load(0)}>
          {label}
        </AsyncButton>
      )}
      <FoldContent>
        {chunk ? (
          <div className="space-y-2 pt-2">
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-base">
              {chunk.text}
            </pre>
            <div className="flex flex-wrap items-center gap-2 text-ui-xs text-foreground-subtle">
              <span>
                {intl.formatMessage(
                  { id: "chat.history.contentRange" },
                  {
                    start: formatBytes(chunk.offset),
                    end: formatBytes(chunk.end),
                    total: formatBytes(reference.totalBytes),
                  },
                )}
              </span>
              {chunk.offset > 0 ? (
                <AsyncButton
                  variant="ghost"
                  size="xs"
                  successFeedback="none"
                  disabled={loading}
                  disabledReason={loading ? loadingLabel : undefined}
                  onClick={() => load(Math.max(0, chunk.offset - CHUNK_BYTES))}
                >
                  {intl.formatMessage({ id: "chat.history.previousChunk" })}
                </AsyncButton>
              ) : null}
              {chunk.next !== undefined ? (
                <AsyncButton
                  variant="ghost"
                  size="xs"
                  successFeedback="none"
                  disabled={loading}
                  disabledReason={loading ? loadingLabel : undefined}
                  onClick={() => load(chunk.next!)}
                >
                  {intl.formatMessage({ id: "chat.history.nextChunk" })}
                </AsyncButton>
              ) : null}
            </div>
          </div>
        ) : null}
      </FoldContent>
    </Fold>
  );
}
