import type { NekQueuedInput, NekStatusQueue } from "@zcode/shared/nek-protocol";

export type QueueContents = NekStatusQueue;

export type QueueKind = "steering" | "followUp";

export interface QueueTarget {
  kind: QueueKind;
  text: string;
  occurrence: number;
}

export type QueueEdit = { type: "delete" } | { type: "replace"; text: string };

export type QueueEditResult =
  | { ok: true; requeue: QueueContents }
  | { ok: false; reason: "consumed"; requeue: QueueContents };

function cloneQueue(queue: QueueContents): QueueContents {
  return {
    steering: [...queue.steering],
    followUp: [...queue.followUp],
    ...(queue.inputs
      ? {
          inputs: {
            steering: queue.inputs.steering.map((item) => ({ ...item })),
            followUp: queue.inputs.followUp.map((item) => ({ ...item })),
          },
        }
      : {}),
  };
}

/** 目标正文可重复；用 kind + 同文 occurrence 取回原附件，不按正文 hash 合并。 */
export function queuedInputAt(
  queue: QueueContents,
  target: QueueTarget,
): NekQueuedInput | undefined {
  const index = findOccurrence(queue[target.kind], target);
  return index < 0 ? undefined : queue.inputs?.[target.kind][index];
}

function findOccurrence(items: readonly string[], target: QueueTarget): number {
  if (target.occurrence < 0) return -1;
  let occurrence = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (items[index] !== target.text) continue;
    if (occurrence === target.occurrence) return index;
    occurrence += 1;
  }
  return -1;
}

/** Alt+↑：按 nek 顺序把全部队列放到草稿之前，消息之间用空行隔开。 */
export function mergeQueuedIntoDraft(queued: QueueContents, draft: string): string {
  const messages = [...queued.steering, ...queued.followUp];
  if (messages.length === 0) return draft;
  const queuedText = messages.join("\n\n");
  return draft.length === 0 ? queuedText : `${queuedText}\n\n${draft}`;
}

/**
 * 基于 clear_queue 的实际返回值计算重新入队内容。
 * 找不到目标表示它已经被 nek 消费；仍返回 actual，保证其余消息照常放回。
 */
export function planQueueEdit(
  actual: QueueContents,
  target: QueueTarget,
  operation: QueueEdit,
): QueueEditResult {
  const requeue = cloneQueue(actual);
  const items = requeue[target.kind];
  const index = findOccurrence(items, target);
  if (index < 0) return { ok: false, reason: "consumed", requeue };
  if (operation.type === "delete") {
    items.splice(index, 1);
    requeue.inputs?.[target.kind].splice(index, 1);
  } else {
    items[index] = operation.text;
    if (requeue.inputs)
      requeue.inputs[target.kind][index] = {
        ...requeue.inputs[target.kind][index]!,
        text: operation.text,
      };
  }
  return { ok: true, requeue };
}

/** 删除撤销按原 kind 追加到对应队列末尾。 */
export function appendQueueItem(
  queue: QueueContents,
  kind: QueueKind,
  text: string,
  input?: NekQueuedInput,
): QueueContents {
  const next = cloneQueue(queue);
  if (!next.inputs && input?.attachments?.length)
    next.inputs = {
      steering: queue.steering.map((value) => ({ text: value })),
      followUp: queue.followUp.map((value) => ({ text: value })),
    };
  next[kind].push(text);
  next.inputs?.[kind].push({ ...input, text });
  return next;
}

export function queueItemTargets(queue: QueueContents): QueueTarget[] {
  return (["steering", "followUp"] as const).flatMap((kind) => {
    const counts = new Map<string, number>();
    return queue[kind].map((text) => {
      const occurrence = counts.get(text) ?? 0;
      counts.set(text, occurrence + 1);
      return { kind, text, occurrence };
    });
  });
}

export interface QueueKeyInput {
  key: string;
  altKey?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  /** React 合成事件的原生键盘事件，IME 组字期间 `isComposing` 只在原生事件上。 */
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  focusTarget?: "editor" | "other";
}

export type QueueEditKeyCommand = "submit" | "cancel";

/**
 * 队列多行编辑的按键语义：
 * - Enter（无 Shift，非 IME 组字）提交；
 * - Shift+Enter 是换行，必须原样放行给文本框；
 * - Escape 取消编辑。
 */
export function resolveQueueEditKey(input: QueueKeyInput): QueueEditKeyCommand | null {
  if (
    input.isComposing ||
    input.keyCode === 229 ||
    input.nativeEvent?.isComposing === true ||
    input.nativeEvent?.keyCode === 229
  ) {
    return null;
  }
  if (input.key === "Enter") {
    if (input.shiftKey === true) return null;
    if (input.ctrlKey === true || input.metaKey === true) return null;
    return "submit";
  }
  if (
    input.key === "Escape" &&
    !input.altKey &&
    !input.shiftKey &&
    !input.ctrlKey &&
    !input.metaKey
  ) {
    return "cancel";
  }
  return null;
}

export function resolveDequeueShortcut(input: QueueKeyInput): boolean {
  return (
    !input.isComposing &&
    input.keyCode !== 229 &&
    input.key === "ArrowUp" &&
    input.altKey === true &&
    !input.shiftKey &&
    !input.ctrlKey &&
    !input.metaKey
  );
}
