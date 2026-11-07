import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { CheckIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { ActionTooltip } from "@/components/ui/action-tooltip.js";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useActionShortcutLabel } from "@/shortcuts/useActionShortcuts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useQueueBarController,
  type QueueBarControllerProps,
  type QueueBarEditing,
  type QueueBarItem,
} from "./useQueueBarController.js";
import { StatusActionButton, renderStatusMessage } from "./viewPrimitives.js";

export type NekQueueBarViewProps = QueueBarControllerProps;

interface QueueEditFieldProps {
  value: string;
  ariaLabel: string;
  placeholder?: string;
  onChange: (next: string) => void;
  onKeyDown: (event: KeyboardEvent<Element>) => void;
  onBlur: () => void;
}

/**
 * 队列消息编辑框：多行、随内容增高。
 * 只能在挂载时聚焦并把光标放到末尾，否则每次按键都会重置选区。
 */
function QueueEditField({
  value,
  ariaLabel,
  placeholder,
  onChange,
  onKeyDown,
  onBlur,
}: QueueEditFieldProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.focus();
    const end = node.value.length;
    node.setSelectionRange(end, end);
  }, []);
  return (
    <Textarea
      ref={ref}
      value={value}
      aria-label={ariaLabel}
      placeholder={placeholder}
      className="min-h-9 max-h-40 w-full resize-none whitespace-pre-wrap break-words text-ui-base leading-5"
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  );
}

/** 当前这一行是否正在编辑：kind + 原文 + 出现序号三者一致才算同一目标。 */
function isQueueItemBeingEdited(editing: QueueBarEditing | null, item: QueueBarItem): boolean {
  if (!editing) return false;
  return (
    editing.target.kind === item.kind &&
    editing.target.text === item.text &&
    editing.target.occurrence === item.occurrence
  );
}

export function NekQueueBarView(props: NekQueueBarViewProps) {
  const { intl } = useZCodeIntl();
  const controller = useQueueBarController(props);
  const dequeueShortcut = useActionShortcutLabel("app.message.dequeue");
  if (!controller.view.visible) return null;
  const title = intl.formatMessage(
    { id: "chat.queue.title" },
    { count: controller.view.items.length },
  );
  const retrieveLabel = intl.formatMessage({ id: "nek.status.queue.retrieveAll" });
  const clearLabel = intl.formatMessage({ id: "nek.status.queue.clearAll" });
  const editLabel = intl.formatMessage({ id: "chat.queue.edit" });
  const removeLabel = intl.formatMessage({ id: "chat.queue.remove" });
  const saveLabel = intl.formatMessage({ id: "common.save" });
  const cancelLabel = intl.formatMessage({ id: "common.cancel" });
  const emptyText = intl.formatMessage({ id: "nek.status.queue.emptyText" });
  return (
    <section
      data-status-view="queue-bar"
      className="flex min-w-0 flex-col gap-1.5 rounded-2xl border border-border bg-surface/80 px-2.5 py-2 backdrop-blur-sm"
    >
      <header className="flex min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate px-1.5 text-ui-sm font-medium text-foreground-subtle">
          {title}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <StatusActionButton
            action={controller.actions.retrieveAll}
            actionId="retrieveAll"
            label={retrieveLabel}
            shortcut={dequeueShortcut}
            variant="ghost"
            size="sm"
          />
          <StatusActionButton
            action={controller.actions.clearAll}
            actionId="clearAll"
            label={clearLabel}
            variant="ghost"
            size="sm"
            className="text-foreground-subtle hover:text-foreground"
          />
        </div>
      </header>
      <ul className="space-y-0.5">
        {controller.view.items.map((item) => {
          const editing = isQueueItemBeingEdited(controller.view.editing, item)
            ? controller.view.editing
            : null;
          const validationError = renderStatusMessage(intl, editing?.validationError);
          const kindLabel = intl.formatMessage({
            id: item.kind === "steering" ? "nek.status.queue.steer" : "nek.status.queue.followUp",
          });
          const itemKey = `${item.kind}:${item.text}:${item.occurrence}`;
          return (
            <li
              key={itemKey}
              data-queue-item={`${item.kind}:${item.occurrence}`}
              className="group relative flex min-w-0 items-start gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-hover/40"
            >
              <span className="mt-0.5 shrink-0 rounded-md bg-hover px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                {kindLabel}
              </span>
              <div className="min-w-0 flex-1">
                {editing ? (
                  <QueueEditField
                    value={editing.draft}
                    ariaLabel={editLabel}
                    placeholder={emptyText}
                    onChange={controller.setDraft}
                    onKeyDown={controller.onKeyDown}
                    onBlur={controller.onBlurEdit}
                  />
                ) : (
                  <div
                    title={item.text}
                    className="line-clamp-4 min-w-0 py-0.5 whitespace-pre-wrap break-words text-ui-base leading-5 text-foreground"
                  >
                    {item.text}
                  </div>
                )}
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
              <div className="flex shrink-0 items-center gap-0.5">
                {editing ? (
                  <>
                    <QueueIconButton
                      label={saveLabel}
                      actionId={`save:${item.kind}:${item.occurrence}`}
                      disabled={!item.edit.enabled}
                      onClick={() => void controller.commitEdit()}
                    >
                      <CheckIcon className="size-4" />
                    </QueueIconButton>
                    <QueueIconButton
                      label={cancelLabel}
                      actionId={`cancel:${item.kind}:${item.occurrence}`}
                      onClick={() => controller.cancelEdit()}
                    >
                      <XIcon className="size-4" />
                    </QueueIconButton>
                  </>
                ) : (
                  <>
                    <QueueItemActionButton
                      action={item.edit}
                      label={editLabel}
                      actionId={`edit:${item.kind}:${item.occurrence}`}
                      onRun={() => void item.edit.run()}
                    >
                      <PencilIcon className="size-4" />
                    </QueueItemActionButton>
                    <QueueItemActionButton
                      action={item.delete}
                      label={removeLabel}
                      actionId={`delete:${item.kind}:${item.occurrence}`}
                      onRun={() => void item.delete.run()}
                    >
                      <Trash2Icon className="size-4" />
                    </QueueItemActionButton>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface QueueItemActionButtonProps {
  action: QueueBarItem["edit"];
  label: string;
  actionId: string;
  onRun: () => void;
  children: ReactNode;
}

/** 队列行内的方形幽灵图标按钮（对齐 ZCodium `QueueRow`），禁用原因走 tooltip。 */
function QueueItemActionButton({
  action,
  label,
  actionId,
  onRun,
  children,
}: QueueItemActionButtonProps) {
  const { intl } = useZCodeIntl();
  const disabled = !action.enabled || action.pending;
  return (
    <ActionTooltip
      label={label}
      description={action.error}
      disabled={disabled}
      disabledReason={renderStatusMessage(intl, action.disabledReason)}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        data-status-action={actionId}
        aria-label={label}
        aria-busy={action.pending || undefined}
        disabled={disabled}
        onClick={onRun}
      >
        {children}
      </Button>
    </ActionTooltip>
  );
}

interface QueueIconButtonProps {
  label: string;
  actionId: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}

/**
 * 编辑态的保存/取消：`onMouseDown` 拦下默认行为，避免按下时先触发 Textarea 失焦提交，
 * 把这一次点击变成"提交一次 + 取消一次"。
 */
function QueueIconButton({
  label,
  actionId,
  disabled = false,
  onClick,
  children,
}: QueueIconButtonProps) {
  return (
    <ActionTooltip label={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        data-status-action={actionId}
        aria-label={label}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
      >
        {children}
      </Button>
    </ActionTooltip>
  );
}
