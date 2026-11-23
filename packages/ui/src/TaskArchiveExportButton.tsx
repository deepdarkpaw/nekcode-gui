import { FileDown } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useConversationImport, type TaskArchiveTarget } from "@/hooks/useConversationImport.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WINDOWS_CAPTION_CONTROL_CLASS } from "@/windowCaptionControls.js";

export function TaskArchiveExportButton({
  target,
  taskId,
  disabledReason,
  useWindowsCaptionSpacing = false,
}: {
  target: TaskArchiveTarget;
  taskId: string;
  disabledReason?: string;
  useWindowsCaptionSpacing?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const archive = useConversationImport();
  if (!archive?.canExport) return null;
  const label = intl.formatMessage({ id: "taskArchive.export" });
  return (
    <ControlHintTooltip title={disabledReason ?? label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        className={cn(
          "text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]",
          useWindowsCaptionSpacing ? "ml-3" : "ml-2.5",
          useWindowsCaptionSpacing && WINDOWS_CAPTION_CONTROL_CLASS,
        )}
        aria-label={label}
        aria-busy={archive.busy}
        data-testid="task-archive-export-trigger"
        disabled={archive.busy || Boolean(disabledReason)}
        onClick={() => archive.exportTask(target, taskId)}
      >
        <FileDown className="size-4" aria-hidden="true" />
      </Button>
    </ControlHintTooltip>
  );
}
