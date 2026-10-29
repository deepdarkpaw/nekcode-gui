import { useCallback, useMemo, useRef, useState } from "react";
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
  resolveQueueEditKey,
  type QueueContents,
  type QueueEdit,
  type QueueTarget,
} from "./queue.js";

export interface QueueBarControllerProps {
  sessionKey: string;
  clearQueue: () => Promise<QueueContents>;
  requeue: (queue: QueueContents) => Promise<void>;
  getComposerText: () => string;
  setComposerText: (text: string) => void;
  focusComposerAtEnd: () => void;
}

export interface QueueBarItem {
  kind: QueueTarget["kind"];
  text: string;
  occurrence: number;
  edit: StatusActionHandle;
  delete: StatusActionHandle;
}

const EMPTY_QUEUE: QueueContents = { steering: [], followUp: [] };

export interface QueueBarController {
  view: {
    visible: boolean;
    items: QueueBarItem[];
    editing: { target: QueueTarget; draft: string; validationError?: StatusMessage } | null;
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
  clearQueue,
  requeue,
  getComposerText,
  setComposerText,
  focusComposerAtEnd,
}: QueueBarControllerProps): QueueBarController {
  const showUndo = useUndoToast();
  const { intl } = useZCodeIntl();
  const queue = useNekStatusStore((state) => state.sessions[sessionKey]?.queue ?? EMPTY_QUEUE);
  const [editing, setEditing] = useState<{
    target: QueueTarget;
    draft: string;
    validationError?: StatusMessage;
  } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const activeOperationRef = useRef<QueueTarget | null>(null);
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
            void requeue(appendQueueItem(result.requeue, target.kind, target.text));
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
      const actual = await clearQueue();
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
      const command = resolveQueueEditKey(event);
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
