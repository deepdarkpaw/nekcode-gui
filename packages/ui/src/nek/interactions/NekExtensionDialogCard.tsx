import type { KeyboardEvent, ReactNode, Ref } from "react";
import type {
  NekExtensionUiDialogRequest,
  NekExtensionUiResponse,
} from "@zcode/shared/nek-protocol";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { InteractionActionButton } from "./InteractionActionButton.js";
import { useConfirmDialogController } from "./confirmDialogController.js";
import { useEditorDialogController } from "./editorDialogController.js";
import { useInputDialogController } from "./inputDialogController.js";
import { useSelectDialogController } from "./selectDialogController.js";
import type { ActiveElementInfo } from "./interactionCommon.js";

export interface NekExtensionDialogCardProps {
  request: NekExtensionUiDialogRequest;
  activeElement?: ActiveElementInfo;
  isQueueHead?: boolean;
  closedByHost?: boolean;
  onRespond: (response: NekExtensionUiResponse) => Promise<void> | void;
  onLostText: (text: string) => void;
}

interface ExtensionDialogShellProps {
  title: string;
  deadline: { remainingMs?: number };
  notice?: string;
  error?: string;
  focusRef: Ref<HTMLDivElement>;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  testId: string;
  children: ReactNode;
}

function ExtensionDialogShell({
  title,
  deadline,
  notice,
  error,
  focusRef,
  onKeyDown,
  testId,
  children,
}: ExtensionDialogShellProps) {
  const { intl } = useZCodeIntl();
  const seconds =
    deadline.remainingMs === undefined
      ? undefined
      : Math.max(0, Math.ceil(deadline.remainingMs / 1000));
  return (
    <div className="w-full shrink-0">
      <div
        ref={focusRef}
        tabIndex={-1}
        data-interaction-focus="card"
        data-testid={testId}
        role="dialog"
        className="relative z-1 flex max-h-[min(72dvh,42rem)] w-full flex-col overflow-hidden rounded-2xl border border-popover-border bg-popover shadow-xs outline-none"
        onKeyDown={onKeyDown}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-3 border-b border-popover-border pb-3">
            <h2 className="min-w-0 break-words text-ui-lg font-medium text-foreground">{title}</h2>
            {seconds !== undefined ? (
              <span
                className="shrink-0 text-ui-sm tabular-nums text-foreground-subtle"
                aria-label={intl.formatMessage(
                  { id: "nek.interaction.dialog.deadline" },
                  { seconds },
                )}
                data-deadline-seconds={seconds}
              >
                {intl.formatMessage({ id: "nek.interaction.dialog.seconds" }, { seconds })}
              </span>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
          {notice ? (
            <p role="status" className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: notice })}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-ui-sm text-[var(--color-danger)]">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SelectDialogCard({
  request,
  activeElement,
  isQueueHead,
  closedByHost,
  onRespond,
}: Omit<NekExtensionDialogCardProps, "request" | "onLostText"> & {
  request: Extract<NekExtensionUiDialogRequest, { method: "select" }>;
}) {
  const controller = useSelectDialogController({
    request,
    activeElement,
    isQueueHead,
    closedByHost,
    onRespond,
  });
  const { intl } = useZCodeIntl();
  return (
    <ExtensionDialogShell
      title={controller.view.title}
      deadline={controller.view.deadline}
      notice={controller.view.notice}
      error={controller.view.error}
      focusRef={controller.focus.ref("filter")}
      onKeyDown={controller.onKeyDown}
      testId="nek-extension-select-card"
    >
      <div className="flex flex-col gap-3">
        <Input
          ref={controller.focus.ref("filter")}
          value={controller.view.filter}
          placeholder={intl.formatMessage({ id: "nek.interaction.dialog.filter" })}
          aria-label={intl.formatMessage({ id: "nek.interaction.dialog.filter" })}
          onChange={(event) => controller.setFilter(event.target.value)}
        />
        {controller.view.empty ? (
          <p className="px-2 py-3 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "nek.interaction.dialog.noResults" })}
          </p>
        ) : (
          <div className="space-y-1" role="listbox" aria-label={controller.view.title}>
            {controller.view.items.map((item, index) => (
              <button
                key={`${item.index}:${item.value}`}
                type="button"
                role="option"
                aria-selected={controller.view.highlighted === index}
                onMouseEnter={() => controller.highlight(index)}
                onClick={() => void controller.select(index)}
                className="w-full rounded-xl px-3 py-2 text-left text-ui-base text-foreground outline-none hover:bg-hover focus-visible:bg-hover"
              >
                {item.value}
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end border-t border-popover-border pt-3">
          <InteractionActionButton
            handle={controller.actions.cancel}
            labelId="nek.interaction.dialog.cancel"
            size="lg"
          />
        </div>
      </div>
    </ExtensionDialogShell>
  );
}

function ConfirmDialogCard({
  request,
  activeElement,
  isQueueHead,
  closedByHost,
  onRespond,
}: Omit<NekExtensionDialogCardProps, "request" | "onLostText"> & {
  request: Extract<NekExtensionUiDialogRequest, { method: "confirm" }>;
}) {
  const controller = useConfirmDialogController({
    request,
    activeElement,
    isQueueHead,
    closedByHost,
    onRespond,
  });
  return (
    <ExtensionDialogShell
      title={controller.view.title}
      deadline={controller.view.deadline}
      notice={controller.view.notice}
      error={controller.view.error}
      focusRef={controller.focus.ref("cancel")}
      onKeyDown={controller.onKeyDown}
      testId="nek-extension-confirm-card"
    >
      <div className="flex flex-col gap-4">
        <p className="whitespace-pre-wrap break-words text-ui-base text-foreground">
          {controller.view.message}
        </p>
        <div className="flex justify-end gap-2 border-t border-popover-border pt-3">
          <InteractionActionButton
            handle={controller.actions.cancel}
            labelId="nek.interaction.dialog.cancel"
            size="lg"
            ref={controller.focus.ref("cancel")}
          />
          <InteractionActionButton
            handle={controller.actions.confirm}
            labelId="nek.interaction.dialog.continue"
            size="lg"
            ref={controller.focus.ref("confirm")}
          />
        </div>
      </div>
    </ExtensionDialogShell>
  );
}

function InputDialogCard({
  request,
  activeElement,
  isQueueHead,
  closedByHost,
  onRespond,
}: Omit<NekExtensionDialogCardProps, "request" | "onLostText"> & {
  request: Extract<NekExtensionUiDialogRequest, { method: "input" }>;
}) {
  const controller = useInputDialogController({
    request,
    activeElement,
    isQueueHead,
    closedByHost,
    onRespond,
  });
  const { intl } = useZCodeIntl();
  return (
    <ExtensionDialogShell
      title={controller.view.title}
      deadline={controller.view.deadline}
      notice={controller.view.notice}
      error={controller.view.error}
      focusRef={controller.focus.ref("input")}
      onKeyDown={controller.onKeyDown}
      testId="nek-extension-input-card"
    >
      <div className="flex flex-col gap-4">
        <Input
          ref={controller.focus.ref("input")}
          value={controller.view.text}
          placeholder={controller.view.placeholder}
          aria-label={
            controller.view.placeholder ??
            intl.formatMessage({ id: "nek.interaction.dialog.input" })
          }
          onChange={(event) => controller.setText(event.target.value)}
        />
        <div className="flex justify-end gap-2 border-t border-popover-border pt-3">
          <InteractionActionButton
            handle={controller.actions.cancel}
            labelId="nek.interaction.dialog.cancel"
            size="lg"
            ref={controller.focus.ref("cancel")}
          />
          <InteractionActionButton
            handle={controller.actions.submit}
            labelId="nek.interaction.dialog.submit"
            size="lg"
          />
        </div>
      </div>
    </ExtensionDialogShell>
  );
}

function EditorDialogCard({
  request,
  activeElement,
  isQueueHead,
  closedByHost,
  onRespond,
  onLostText,
}: Omit<NekExtensionDialogCardProps, "request"> & {
  request: Extract<NekExtensionUiDialogRequest, { method: "editor" }>;
}) {
  const controller = useEditorDialogController({
    request,
    activeElement,
    isQueueHead,
    closedByHost,
    onRespond,
    onLostText,
  });
  const { intl } = useZCodeIntl();
  return (
    <ExtensionDialogShell
      title={controller.view.title}
      deadline={controller.view.deadline}
      notice={controller.view.notice}
      error={controller.view.error}
      focusRef={controller.focus.ref("editor")}
      onKeyDown={controller.onKeyDown}
      testId="nek-extension-editor-card"
    >
      <div className="flex flex-col gap-4">
        <Textarea
          ref={controller.focus.ref("editor")}
          value={controller.view.text}
          aria-label={controller.view.title}
          onChange={(event) => controller.setText(event.target.value)}
          className="max-h-[min(48dvh,28rem)] min-h-32 resize-y text-ui-base"
        />
        {controller.view.confirmDiscard ? (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-card-border bg-card p-3">
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "nek.interaction.dialog.confirmDiscard" })}
            </p>
            <div className="flex shrink-0 gap-2">
              <InteractionActionButton
                handle={controller.actions.keepEditing}
                labelId="nek.interaction.dialog.keepEditing"
                size="sm"
                ref={controller.focus.ref("keepEditing")}
              />
              <InteractionActionButton
                handle={controller.actions.discard}
                labelId="nek.interaction.dialog.discard"
                size="sm"
              />
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2 border-t border-popover-border pt-3">
            <InteractionActionButton
              handle={controller.actions.cancel}
              labelId="nek.interaction.dialog.cancel"
              size="lg"
            />
            <InteractionActionButton
              handle={controller.actions.submit}
              labelId="nek.interaction.dialog.submit"
              size="lg"
            />
          </div>
        )}
      </div>
    </ExtensionDialogShell>
  );
}

/** Dispatch only: each dialog view owns one corresponding headless controller. */
export function NekExtensionDialogCard({ request, ...props }: NekExtensionDialogCardProps) {
  switch (request.method) {
    case "select":
      return <SelectDialogCard request={request} {...props} />;
    case "confirm":
      return <ConfirmDialogCard request={request} {...props} />;
    case "input":
      return <InputDialogCard request={request} {...props} />;
    case "editor":
      return <EditorDialogCard request={request} {...props} />;
  }
}
