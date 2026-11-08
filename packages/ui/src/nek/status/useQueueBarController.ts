import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useUndoToast } from "@/components/ui/undo-toast.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNekStatusStore } from "./store.js";
import {
  ACTION_BUSY,
  type StatusActionHandle,
  type StatusKeyDown,
  type StatusMessage,
} from "./controllerTypes.js";
import {
  appendQueueItem,
  mergeQueuedIntoDraft,
  planQueueEdit,
  queueItemTargets,
  queuedInputAt,
  resolveQueueEditKey,
  type QueueContents,
  type QueueEdit,
  type QueueTarget,
} from "./queue.js";

export interface QueueBarControllerProps {
  sessionKey: string;
  composerScopeKey?: string;
  clearQueue: () => Promise<QueueContents>;
  requeue: (queue: QueueContents) => Promise<void>;
  getComposerText: () => string;
  setComposerText: (text: string) => void;
  restoreComposerAttachments?: (attachments: readonly AttachmentRef[]) => boolean;
  focusComposerAtEnd: () => void;
}

export interface QueueBarItem {
  kind: QueueTarget["kind"];
  text: string;
  occurrence: number;
  edit: StatusActionHandle;
  delete: StatusActionHandle;
}

/** 正在编辑的队列项：目标 + 草稿 + 行内校验错误。 */
export interface QueueBarEditing {
  target: QueueTarget;
  draft: string;
  validationError?: StatusMessage;
}

const EMPTY_QUEUE: QueueContents = { steering: [], followUp: [] };

export interface QueueBarController {
  view: {
    visible: boolean;
    items: QueueBarItem[];
    editing: QueueBarEditing | null;
  };
  actions: {
    retrieveAll: StatusActionHandle;
    clearAll: StatusActionHandle;
  };
  setDraft: (draft: string) => void;
  commitEdit: (draft?: string) => Promise<void>;
  cancelEdit: () => void;
  onBlurEdit: () => void;
  onDequeueShortcut: () => Promise<boolean>;
  onKeyDown: StatusKeyDown;
}

function operationKey(operation: QueueTarget): string {
  return `${operation.kind}:${operation.text}:${operation.occurrence}`;
}

export function useQueueBarController({
  sessionKey,
  composerScopeKey,
  clearQueue,
  requeue,
  getComposerText,
  setComposerText,
  restoreComposerAttachments,
  focusComposerAtEnd,
}: QueueBarControllerProps): QueueBarController {
  const showUndo = useUndoToast();
  const { intl } = useZCodeIntl();
  const queue = useNekStatusStore((state) => state.sessions[sessionKey]?.queue ?? EMPTY_QUEUE);
  const [editing, setEditing] = useState<QueueBarEditing | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const activeOperationRef = useRef<QueueTarget | null>(null);
  const scopeKey = composerScopeKey ?? sessionKey;
  const scopeRef = useRef({ scopeKey });
  if (scopeRef.current.scopeKey !== scopeKey) scopeRef.current = { scopeKey };
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const operationAction = useAsyncAction(
    async ({ target, operation }: { target: QueueTarget; operation: QueueEdit }) => {
      const actual = await clearQueue();
      const result = planQueueEdit(actual, target, operation);
      await requeue(result.requeue);
      if (!result.ok) {
        toast(intl.formatMessage({ id: "nek.status.queue.consumed" }));
        setEditing(null);
        return;
      }
      if (operation.type === "delete") {
        showUndo({
          message: `${intl.formatMessage({ id: "nek.status.queue.deleted" })} · ${intl.formatMessage({ id: "nek.status.queue.undoAppends" })}`,
          durationMs: 5_000,
          onUndo: () => {
            void requeue(
              appendQueueItem(
                result.requeue,
                target.kind,
                target.text,
                queuedInputAt(actual, target),
              ),
            );
          },
        });
      } else {
        setEditing(null);
      }
    },
    {
      successFeedbackMs: 0,
      onError: (error) => {
        const target = activeOperationRef.current;
        if (!target) return;
        setErrors((current) => ({
          ...current,
          [operationKey(target)]: error instanceof Error ? error.message : String(error),
        }));
      },
    },
  );
  const retrieveAction = useAsyncAction(
    async () => {
      const owner = scopeRef.current;
      const actual = await clearQueue();
      if (!mountedRef.current || scopeRef.current !== owner) {
        await requeue(actual);
        return;
      }
      const files = [...(actual.inputs?.steering ?? []), ...(actual.inputs?.followUp ?? [])]
        .flatMap((input) => input.attachments ?? [])
        .map((file) => ({
          ref: file.path,
          fileName: file.fileName,
          mime: file.mimeType,
          bytes: file.sizeBytes,
        }));
      if (files.length && !restoreComposerAttachments?.(files)) {
        // 草稿放不下时先放回权威队列；不能只取回正文却把已接纳的文件遗失。
        await requeue(actual);
        throw new Error(intl.formatMessage({ id: "nek.status.queue.attachmentsFull" }));
      }
      setComposerText(mergeQueuedIntoDraft(actual, getComposerText()));
      focusComposerAtEnd();
    },
    { successFeedbackMs: 0 },
  );
  const clearAction = useAsyncAction(
    async () => {
      const actual = await clearQueue();
      const count = actual.steering.length + actual.followUp.length;
      showUndo({
        message: intl.formatMessage({ id: "nek.status.queue.cleared" }, { count }),
        durationMs: 5_000,
        onUndo: () => {
          void requeue(actual);
        },
      });
    },
    { successFeedbackMs: 0 },
  );
  const busy =
    operationAction.state.status === "pending" ||
    retrieveAction.state.status === "pending" ||
    clearAction.state.status === "pending";

  const startEdit = useCallback(
    (target: QueueTarget) => {
      if (busy) return;
      setErrors((current) => {
        const next = { ...current };
        delete next[operationKey(target)];
        return next;
      });
      setEditing({ target, draft: target.text });
    },
    [busy],
  );
  const setDraft = useCallback((draft: string) => {
    setEditing((current) =>
      current ? { ...current, draft, validationError: undefined } : current,
    );
  }, []);
  const commitEdit = useCallback(
    async (draftOverride?: string) => {
      if (!editing || busy) return;
      const draft = draftOverride ?? editing.draft;
      if (draft.trim() === "") {
        setEditing({ ...editing, draft, validationError: { id: "nek.status.queue.emptyText" } });
        return;
      }
      // 失焦提交很常见（点到别处）；内容没变就不必 clear_queue + requeue 走一往返。
      if (draft === editing.target.text) {
        setEditing(null);
        return;
      }
      activeOperationRef.current = editing.target;
      await operationAction.run({
        target: editing.target,
        operation: { type: "replace", text: draft },
      });
      activeOperationRef.current = null;
    },
    [busy, editing, operationAction],
  );
  const cancelEdit = useCallback(() => setEditing(null), []);
  const onBlurEdit = useCallback(() => void commitEdit(), [commitEdit]);

  const runDelete = useCallback(
    async (target: QueueTarget) => {
      if (busy) return;
      activeOperationRef.current = target;
      await operationAction.run({ target, operation: { type: "delete" } });
      activeOperationRef.current = null;
    },
    [busy, operationAction],
  );

  const itemViews = queueItemTargets(queue).map((target) => {
    const targetKey = operationKey(target);
    const edit: StatusActionHandle = {
      visible: true,
      enabled: !busy,
      ...(busy ? { disabledReason: ACTION_BUSY } : {}),
      pending: false,
      error: errors[targetKey],
      run: async () => startEdit(target),
    };
    const deleteAction: StatusActionHandle = {
      visible: true,
      enabled: !busy,
      ...(busy ? { disabledReason: ACTION_BUSY } : {}),
      pending:
        busy &&
        activeOperationRef.current?.kind === target.kind &&
        activeOperationRef.current?.text === target.text,
      error: errors[targetKey],
      run: async () => await runDelete(target),
    };
    return { ...target, edit, delete: deleteAction };
  });

  const retrievePending = retrieveAction.state.status === "pending";
  const clearPending = clearAction.state.status === "pending";
  const retrieveAll: StatusActionHandle = useMemo(
    () => ({
      visible: itemViews.length > 0,
      enabled: itemViews.length > 0 && !busy,
      ...(itemViews.length > 0 && busy ? { disabledReason: ACTION_BUSY } : {}),
      pending: retrievePending,
      shortcutActionId: "app.message.dequeue",
      error: retrieveAction.state.status === "error" ? retrieveAction.state.message : undefined,
      run: async () => {
        if (itemViews.length > 0 && !busy) await retrieveAction.run();
      },
    }),
    [busy, itemViews.length, retrieveAction, retrievePending],
  );
  const clearAll: StatusActionHandle = useMemo(
    () => ({
      visible: itemViews.length > 0,
      enabled: itemViews.length > 0 && !busy,
      ...(itemViews.length > 0 && busy ? { disabledReason: ACTION_BUSY } : {}),
      pending: clearPending,
      destructive: true,
      error: clearAction.state.status === "error" ? clearAction.state.message : undefined,
      run: async () => {
        if (itemViews.length > 0 && !busy) await clearAction.run();
      },
    }),
    [busy, clearAction, clearPending, itemViews.length],
  );

  const onDequeueShortcut = useCallback(async () => {
    if (itemViews.length === 0) return false;
    await retrieveAll.run();
    return true;
  }, [itemViews.length, retrieveAll]);
  const onKeyDown = useCallback(
    (event: Parameters<StatusKeyDown>[0]) => {
      if (!editing) return;
      const command = resolveQueueEditKey({
        key: event.key,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        keyCode: event.keyCode,
        nativeEvent: event.nativeEvent,
      });
      // Shift+Enter / IME 组字返回 null：放行给文本框插入换行，绝不提交。
      if (!command) return;
      event.preventDefault();
      if (command === "submit") void commitEdit();
      else {
        event.stopPropagation();
        cancelEdit();
      }
    },
    [cancelEdit, commitEdit, editing],
  );

  return {
    view: { visible: itemViews.length > 0, items: itemViews, editing },
    actions: { retrieveAll, clearAll },
    setDraft,
    commitEdit,
    cancelEdit,
    onBlurEdit,
    onDequeueShortcut,
    onKeyDown,
  };
}
