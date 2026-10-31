/**
 * 子代理完成的系统通知（02-status RB-6）。
 *
 * 状态 reducer 在子代理从 running 进入终态时发一次 `subagentFinished`
 * （id 去重、有界 200，见 `status/reducerUtils.ts`）。这里把事件翻成平台通知载荷：
 *
 * - `taskId` 用**父会话** id，点通知时 `useRootPlatformEffects` 的
 *   `onTaskNotificationClick` 会激活对应 workspace 并切到该会话；
 * - 完成 → `completed`，出错/停止 → `failed`；
 * - 文案由 renderer 按当前语言生成（main 进程没有语言上下文，只负责展示）；
 * - "窗口有焦点时不通知"由 desktop main 的 `dispatchTaskNotification` 判断，这里不重复。
 */
import { useCallback } from "react";
import type { TaskNotificationPayload } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { NekStatusEventOutput, SubagentFinishedEvent } from "@/nek/status/types.js";

type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

export interface SubagentFinishedNotificationSinks {
  formatMessage: FormatMessage;
  showTaskNotification: (payload: TaskNotificationPayload) => void;
  logger?: { warn: (message: string, context?: unknown) => void };
}

/** 纯函数：一个 status 输出里的完成事件 → 平台通知载荷（每个事件一条）。 */
export function buildSubagentFinishedNotifications(
  sessionKey: string,
  output: NekStatusEventOutput,
  formatMessage: FormatMessage,
): TaskNotificationPayload[] {
  return (output.subagentFinished ?? []).map((event) =>
    subagentFinishedPayload(sessionKey, event, formatMessage),
  );
}

function subagentFinishedPayload(
  sessionKey: string,
  event: SubagentFinishedEvent,
  formatMessage: FormatMessage,
): TaskNotificationPayload {
  const completed = event.status === "completed";
  return {
    taskId: sessionKey,
    status: completed ? "completed" : "failed",
    title: formatMessage({
      id: completed ? "notification.subagentCompleted" : "notification.subagentFailed",
    }),
    body: formatMessage(
      {
        id: completed ? "notification.subagentCompletedBody" : "notification.subagentFailedBody",
      },
      { description: event.description },
    ),
  };
}

/**
 * 把完成事件送到平台通知通道。单条通知失败只记日志：系统通知是旁路，
 * 不能让它连带影响状态视图或后续事件。
 */
export function dispatchSubagentFinishedNotifications(
  sessionKey: string,
  output: NekStatusEventOutput,
  sinks: SubagentFinishedNotificationSinks,
): void {
  const log = sinks.logger ?? logger;
  for (const payload of buildSubagentFinishedNotifications(
    sessionKey,
    output,
    sinks.formatMessage,
  )) {
    try {
      sinks.showTaskNotification(payload);
    } catch (error) {
      log.warn("[nek-status] failed to dispatch subagent notification", { error, sessionKey });
    }
  }
}

/** 状态 feed 的输出回调：接到当前窗口的平台通知通道。 */
export function useNekSubagentFinishedNotifications(): (
  sessionKey: string,
  output: NekStatusEventOutput,
) => void {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  return useCallback(
    (sessionKey: string, output: NekStatusEventOutput) => {
      dispatchSubagentFinishedNotifications(sessionKey, output, {
        formatMessage: (descriptor, values) => intl.formatMessage(descriptor, values),
        showTaskNotification: (payload) => platform.showTaskNotification(payload),
      });
    },
    [intl, platform],
  );
}
