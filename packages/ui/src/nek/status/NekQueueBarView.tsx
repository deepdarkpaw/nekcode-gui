import { Pencil, Trash2 } from "lucide-react";
import { InlineEdit } from "@/components/ui/inline-edit.js";
import { useActionShortcutLabel } from "@/shortcuts/useActionShortcuts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useQueueBarController, type QueueBarControllerProps } from "./useQueueBarController.js";
import { StatusActionButton, renderStatusMessage } from "./viewPrimitives.js";

export type NekQueueBarViewProps = QueueBarControllerProps;

export function NekQueueBarView(props: NekQueueBarViewProps) {
  const { intl, locale } = useZCodeIntl();
  const controller = useQueueBarController(props);
  const dequeueShortcut = useActionShortcutLabel("app.message.dequeue");
  if (!controller.view.visible) return null;
  const retrieveLabel = intl.formatMessage({ id: "nek.status.queue.retrieveAll" });
  const clearLabel = intl.formatMessage({ id: "nek.status.queue.clearAll" });
  const editLabel = locale === "zh-CN" ? "编辑" : "Edit";
  const deleteLabel = intl.formatMessage({ id: "common.delete" });
  const emptyText = intl.formatMessage({ id: "nek.status.queue.emptyText" });
  return (
    <section
      data-status-view="queue-bar"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-card-border bg-card p-2"
      onKeyDown={controller.onKeyDown}
    >
      <header className="flex items-center justify-between gap-2">
        <span className="font-medium text-ui-base text-foreground">{clearLabel}</span>
        <div className="flex items-center gap-1">
          <StatusActionButton
            action={controller.actions.retrieveAll}
            actionId="retrieveAll"
            label={retrieveLabel}
            shortcut={dequeueShortcut}
            variant="outline"
            size="xs"
          />
          <StatusActionButton
            action={controller.actions.clearAll}
            actionId="clearAll"
            label={clearLabel}
            variant="destructive"
            size="xs"
          />
        </div>
      </header>
      <ul className="space-y-1">
        {controller.view.items.map((item) => {
          const isEditing =
            controller.view.editing?.target.kind === item.kind &&
            controller.view.editing.target.text === item.text &&
            controller.view.editing.target.occurrence === item.occurrence;
          const text = isEditing ? (controller.view.editing?.draft ?? item.text) : item.text;
          const validationError = isEditing
            ? renderStatusMessage(intl, controller.view.editing?.validationError)
            : undefined;
          const kindLabel = intl.formatMessage({
            id: item.kind === "steering" ? "nek.status.queue.steer" : "nek.status.queue.followUp",
          });
          return (
            <li
              key={`${item.kind}:${item.text}:${item.occurrence}`}
              className="flex min-w-0 items-start gap-2 rounded-md bg-surface px-2 py-1.5"
            >
              <span className="shrink-0 rounded bg-selected px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                {kindLabel}
              </span>
              <div className="min-w-0 flex-1">
                <InlineEdit
                  value={text}
                  editing={isEditing}
                  onEditingChange={(editing) => {
                    if (editing) void item.edit.run();
                    else controller.cancelEdit();
                  }}
                  onCommit={(next) => controller.commitEdit(next)}
                  validate={(next) => (next.trim() ? null : emptyText)}
                  aria-label={editLabel}
                  size="sm"
                />
                {validationError ? (
                  <p role="alert" className="mt-1 text-ui-sm text-destructive">
                    {validationError}
                  </p>
                ) : null}
                {item.edit.error ? (
                  <p role="alert" className="mt-1 text-ui-sm text-destructive">
                    {item.edit.error}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <StatusActionButton
                  action={item.edit}
                  actionId={`edit:${item.kind}:${item.occurrence}`}
                  label={editLabel}
                  variant="ghost"
                  size="xs"
                >
                  <Pencil aria-hidden="true" />
                </StatusActionButton>
                <StatusActionButton
                  action={item.delete}
                  actionId={`delete:${item.kind}:${item.occurrence}`}
                  label={deleteLabel}
                  variant="destructive"
                  size="xs"
                >
                  <Trash2 aria-hidden="true" />
                </StatusActionButton>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
