import { describe, expect, it, vi } from "vitest";
import type { TaskNotificationPayload } from "@zcode/shared";
import type { NekStatusEventOutput } from "@/nek/status/types.js";
import {
  buildSubagentFinishedNotifications,
  dispatchSubagentFinishedNotifications,
} from "./subagentFinishedNotifications.js";

const formatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
): string => {
  const suffix = values?.description ? `:${String(values.description)}` : "";
  return `${descriptor.id}${suffix}`;
};

function output(
  status: "completed" | "errored" | "aborted",
  description = "explorer",
): NekStatusEventOutput {
  return {
    needsStatsRefresh: false,
    subagentFinished: [
      {
        type: "subagentFinished",
        sessionKey: "session-1",
        id: "child-1",
        status,
        description,
        background: true,
      },
    ],
  };
}

describe("subagent finished notifications", () => {
  it("RB-6: a completed subagent notifies the parent session as completed", () => {
    const [payload] = buildSubagentFinishedNotifications(
      "session-1",
      output("completed"),
      formatMessage,
    );
    expect(payload).toStrictEqual({
      taskId: "session-1",
      status: "completed",
      title: "notification.subagentCompleted",
      body: "notification.subagentCompletedBody:explorer",
    });
  });

  it("RB-6: errored and aborted subagents notify as failed", () => {
    for (const status of ["errored", "aborted"] as const) {
      const [payload] = buildSubagentFinishedNotifications(
        "session-1",
        output(status, "worker"),
        formatMessage,
      );
      expect(payload).toMatchObject({
        status: "failed",
        title: "notification.subagentFailed",
        body: "notification.subagentFailedBody:worker",
      });
    }
  });

  it("RB-6: a status output without finished events produces no notification", () => {
    expect(
      buildSubagentFinishedNotifications("session-1", { needsStatsRefresh: true }, formatMessage),
    ).toEqual([]);
  });

  it("dispatches every finished event to the platform notification channel", () => {
    const showTaskNotification = vi.fn<(payload: TaskNotificationPayload) => void>();
    dispatchSubagentFinishedNotifications("session-1", output("completed"), {
      formatMessage,
      showTaskNotification,
    });
    expect(showTaskNotification).toHaveBeenCalledTimes(1);
    expect(showTaskNotification).toHaveBeenCalledWith({
      taskId: "session-1",
      status: "completed",
      title: "notification.subagentCompleted",
      body: "notification.subagentCompletedBody:explorer",
    });
  });

  it("logs a failing notification channel instead of breaking the status feed", () => {
    const warn = vi.fn();
    const showTaskNotification = vi.fn(() => {
      throw new Error("notification unavailable");
    });
    dispatchSubagentFinishedNotifications("session-1", output("completed"), {
      formatMessage,
      showTaskNotification,
      logger: { warn },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, context] = warn.mock.calls[0] ?? [];
    expect(message).toBe("[nek-status] failed to dispatch subagent notification");
    expect(context).toMatchObject({
      error: expect.objectContaining({ message: "notification unavailable" }),
      sessionKey: "session-1",
    });
  });
});
