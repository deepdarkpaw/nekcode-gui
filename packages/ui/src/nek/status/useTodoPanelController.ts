import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useFoldState } from "@/lib/foldState.js";
import { useNekStatusStore } from "./store.js";
import { NEK_STATUS_TODO_CHANGE_MS } from "./types.js";
import type { NekTodo } from "@zcode/shared/nek-protocol";
import type { StatusActionHandle, StatusKeyDown, StatusMessage } from "./controllerTypes.js";
import { ACTION_BUSY } from "./controllerTypes.js";

export interface TodoPanelControllerProps {
  sessionKey: string;
  onOpenPlan: (path: string) => Promise<void> | void;
  onJumpToTodo: (id: string) => void;
  canJumpToTodo: (id: string) => boolean;
}

export interface TodoViewItem {
  id: string;
  content: string;
  status: NekTodo["status"];
  statusId: string;
  jumpable: boolean;
}

export interface TodoPanelController {
  view: {
    visible: boolean;
    items: TodoViewItem[];
    summary: StatusMessage;
    allDone: boolean;
    recentlyChanged: string[];
    fold: { id: string; open: boolean; onOpenChange: (open: boolean) => void };
    activePlanPath?: string;
  };
  actions: { openPlan: StatusActionHandle };
  jump: (id: string) => void;
  onKeyDown: StatusKeyDown;
}

function statusId(status: NekTodo["status"]): string {
  switch (status) {
    case "pending":
      return "nek.status.todo.pending";
    case "in_progress":
      return "nek.status.todo.inProgress";
    case "completed":
      return "nek.status.todo.completed";
    case "cancelled":
      return "nek.status.todo.cancelled";
  }
}

export function useTodoPanelController({
  sessionKey,
  onOpenPlan,
  onJumpToTodo,
  canJumpToTodo,
}: TodoPanelControllerProps): TodoPanelController {
  const status = useNekStatusStore((state) => state.sessions[sessionKey]);
  const todos = status?.todos ?? [];
  const activePlanPath = status?.activePlanPath;
  const [open, setOpen] = useFoldState(
    `todos:${sessionKey}`,
    null,
    todos.some((todo) => todo.status === "pending" || todo.status === "in_progress"),
  );
  const [recentlyChanged, setRecentlyChanged] = useState<string[]>([]);
  const previousStatusesRef = useRef(new Map<string, NekTodo["status"]>());
  const removalTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const previous = previousStatusesRef.current;
    const changed = todos
      .filter((todo) => previous.has(todo.id) && previous.get(todo.id) !== todo.status)
      .map((todo) => todo.id);
    if (changed.length > 0) {
      setRecentlyChanged((current) => [...new Set([...current, ...changed])]);
      for (const id of changed) {
        const currentTimer = removalTimersRef.current.get(id);
        if (currentTimer) clearTimeout(currentTimer);
        const timer = setTimeout(() => {
          setRecentlyChanged((current) => current.filter((item) => item !== id));
          removalTimersRef.current.delete(id);
        }, NEK_STATUS_TODO_CHANGE_MS);
        removalTimersRef.current.set(id, timer);
      }
    }
    previousStatusesRef.current = new Map(todos.map((todo) => [todo.id, todo.status]));
  }, [todos]);

  useEffect(
    () => () => {
      for (const timer of removalTimersRef.current.values()) clearTimeout(timer);
      removalTimersRef.current.clear();
    },
    [],
  );

  const openPlanAction = useAsyncAction(
    async () => {
      if (!activePlanPath) return;
      await onOpenPlan(activePlanPath);
    },
    { successFeedbackMs: 0 },
  );
  const openPlanPending = openPlanAction.state.status === "pending";
  const openPlan: StatusActionHandle = useMemo(
    () => ({
      visible: activePlanPath !== undefined,
      enabled: activePlanPath !== undefined && !openPlanPending,
      ...(activePlanPath !== undefined && openPlanPending ? { disabledReason: ACTION_BUSY } : {}),
      pending: openPlanPending,
      error: openPlanAction.state.status === "error" ? openPlanAction.state.message : undefined,
      run: async () => {
        if (activePlanPath && !openPlanPending) await openPlanAction.run();
      },
    }),
    [activePlanPath, openPlanAction, openPlanPending],
  );

  const jump = useCallback(
    (id: string) => {
      if (canJumpToTodo(id)) onJumpToTodo(id);
    },
    [canJumpToTodo, onJumpToTodo],
  );
  const total = todos.filter((todo) => todo.status !== "cancelled").length;
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const allDone = total > 0 && completed === total;
  const items = todos.map((todo) => ({
    id: todo.id,
    content: todo.content,
    status: todo.status,
    statusId: statusId(todo.status),
    jumpable: canJumpToTodo(todo.id),
  }));

  return {
    view: {
      visible: todos.length > 0,
      items,
      summary: { id: "nek.status.todo.summary", values: { completed, total } },
      allDone,
      recentlyChanged,
      fold: { id: `todos:${sessionKey}`, open, onOpenChange: setOpen },
      ...(activePlanPath ? { activePlanPath } : {}),
    },
    actions: { openPlan },
    jump,
    onKeyDown: () => undefined,
  };
}
