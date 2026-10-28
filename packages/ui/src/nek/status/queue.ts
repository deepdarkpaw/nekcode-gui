export interface QueueContents {
  steering: string[];
  followUp: string[];
}

export type QueueKind = "steering" | "followUp";

export interface QueueTarget {
  kind: QueueKind;
  text: string;
  occurrence: number;
}

export type QueueEdit =
  | { type: "delete" }
  | { type: "replace"; text: string };

export type QueueEditResult =
  | { ok: true; requeue: QueueContents }
  | { ok: false; reason: "consumed"; requeue: QueueContents };

function cloneQueue(queue: QueueContents): QueueContents {
  return { steering: [...queue.steering], followUp: [...queue.followUp] };
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
  } else {
    items[index] = operation.text;
  }
  return { ok: true, requeue };
}

/** 删除撤销按原 kind 追加到对应队列末尾。 */
export function appendQueueItem(
  queue: QueueContents,
  kind: QueueKind,
  text: string,
): QueueContents {
  return { ...cloneQueue(queue), [kind]: [...queue[kind], text] };
}

export function queueItemTargets(queue: QueueContents): QueueTarget[] {
  return [
    ...queue.steering.map((text, occurrence) => ({ kind: "steering" as const, text, occurrence })),
    ...queue.followUp.map((text, occurrence) => ({ kind: "followUp" as const, text, occurrence })),
  ];
}

export interface QueueKeyInput {
  key: string;
  altKey?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  focusTarget?: "editor" | "other";
}

export type QueueEditKeyCommand = "submit" | "cancel";

export function resolveQueueEditKey(input: QueueKeyInput): QueueEditKeyCommand | null {
  if (input.isComposing || input.keyCode === 229) return null;
  if (input.key === "Enter" && !input.shiftKey && !input.ctrlKey && !input.metaKey) {
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
EOF