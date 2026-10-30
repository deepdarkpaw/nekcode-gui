/**
 * 交互 store 的纯状态helpers：会话槽创建、计时判断，以及 fire-and-forget
 * （notify / setStatus / setWidget / setTitle / set_editor_text）的状态收口。
 *
 * 这些函数不读时钟、不碰 store，接收当前状态并返回下一个状态，方便单独推演上限行为。
 */
import { logger } from "@/logger.js";
import type { NekExtensionUiEffect } from "./extensionUi.js";
import { EMPTY_INTERACTION_QUEUE, type InteractionQueueState } from "./interactionQueue.js";

/** Fire-and-forget notifications are an event stream, not an unbounded toast history. */
const INTERACTION_EFFECT_LIMIT = 64;
const INTERACTION_STATUS_LIMIT = 32;
const INTERACTION_WIDGET_LIMIT = 16;
const INTERACTION_WIDGET_LINE_LIMIT = 50;

export interface InteractionWidget {
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
  truncated: boolean;
}

/** store 里与 fire-and-forget 相关、可整体替换的那一部分。 */
export interface InteractionFireAndForgetState {
  effects: NekExtensionUiEffect[];
  statuses: Readonly<Record<string, string>>;
  widgets: Readonly<Record<string, InteractionWidget>>;
  titleOverride?: string;
}

/** 一个会话槽的完整状态：FIFO 队列 + fire-and-forget 状态 + 时钟快照。 */
export interface InteractionSessionState
  extends InteractionQueueState, InteractionFireAndForgetState {
  clockMs: number;
}

export function timeoutMs(request: object): number | undefined {
  if (!("timeout" in request) || typeof request.timeout !== "number") return undefined;
  if (!Number.isFinite(request.timeout)) return undefined;
  return Math.max(0, request.timeout);
}

export function createSession(now: number): InteractionSessionState {
  return {
    ...EMPTY_INTERACTION_QUEUE,
    effects: [],
    statuses: {},
    widgets: {},
    clockMs: now,
  };
}

export function hasDeadline(sessions: Readonly<Record<string, InteractionQueueState>>): boolean {
  return Object.values(sessions).some((session) =>
    session.queue.some((record) => record.deadline !== undefined),
  );
}

export function sessionWithQueue(
  session: InteractionSessionState,
  queue: InteractionQueueState,
): InteractionSessionState {
  return { ...session, ...queue };
}

/** statuses / widgets / effects / titleOverride 的下一状态；toast 只作为事件，不落状态。 */
export function applyFireAndForgetEffect(
  state: InteractionFireAndForgetState,
  effect: NekExtensionUiEffect,
): InteractionFireAndForgetState {
  const statuses = { ...state.statuses };
  const widgets = { ...state.widgets };
  let titleOverride = state.titleOverride;
  if (effect.kind === "setStatus") {
    if (!effect.statusText?.trim()) {
      delete statuses[effect.statusKey];
    } else {
      if (
        !Object.hasOwn(statuses, effect.statusKey) &&
        Object.keys(statuses).length >= INTERACTION_STATUS_LIMIT
      ) {
        const oldest = Object.keys(statuses)[0];
        if (oldest) delete statuses[oldest];
        logger.warn("[NekInteractionStore] status limit reached");
      }
      statuses[effect.statusKey] = effect.statusText;
    }
  } else if (effect.kind === "setWidget") {
    if (!effect.widgetLines) {
      delete widgets[effect.widgetKey];
    } else {
      const truncated = effect.widgetLines.length > INTERACTION_WIDGET_LINE_LIMIT;
      const nextWidget = {
        lines: effect.widgetLines.slice(0, INTERACTION_WIDGET_LINE_LIMIT),
        placement: effect.widgetPlacement,
        truncated,
      } satisfies InteractionWidget;
      if (
        !Object.hasOwn(widgets, effect.widgetKey) &&
        Object.keys(widgets).length >= INTERACTION_WIDGET_LIMIT
      ) {
        const oldest = Object.keys(widgets)[0];
        if (oldest) delete widgets[oldest];
        logger.warn("[NekInteractionStore] widget limit reached");
      }
      widgets[effect.widgetKey] = nextWidget;
    }
  } else if (effect.kind === "setTitle") {
    titleOverride = effect.title || undefined;
  }
  return {
    effects: [...state.effects, effect].slice(-INTERACTION_EFFECT_LIMIT),
    statuses,
    widgets,
    titleOverride,
  };
}
