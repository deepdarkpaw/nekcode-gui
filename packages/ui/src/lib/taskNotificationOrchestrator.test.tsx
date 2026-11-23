// @vitest-environment happy-dom
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import { collectTerminalTaskNotificationPayloads } from "./taskNotificationOrchestrator.js";

afterEach(cleanup);

const session: SessionSummary = {
  sessionId: "session",
  workspaceId: "scope-key",
  title: "",
  phase: "running",
  sessionEnded: false,
  hasBackgroundWork: false,
  lastActivityAt: 1,
  createdAt: 1,
};

it.each([
  {
    locale: "zh-CN",
    title: "任务已完成",
    workspacePath: "C:\\work\\fixture\\",
    untitledBody: "工作区：fixture",
    titledBody: "任务：Implement feature",
  },
  {
    locale: "en-US",
    title: "Task completed",
    workspacePath: "/work/fixture/",
    untitledBody: "Workspace: fixture",
    titledBody: "Task: Implement feature",
  },
] as const)("ZR-8 untitled completion notifications name the workspace in $locale", (entry) => {
  const { result } = renderHook(() => useZCodeIntl().intl, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ZCodeIntlProvider initialLocale={entry.locale}>{children}</ZCodeIntlProvider>
    ),
  });
  const collect = (title: string) =>
    collectTerminalTaskNotificationPayloads({
      previousBySessionId: new Map([[session.sessionId, session]]),
      sessions: [{ ...session, phase: "completedSuccess", title }],
      workspacePath: entry.workspacePath,
      formatMessage: result.current.formatMessage,
    });

  expect(collect("  ")).toEqual([
    {
      taskId: session.sessionId,
      status: "completed",
      title: entry.title,
      body: entry.untitledBody,
    },
  ]);
  expect(collect(" Implement feature ")).toEqual([
    { taskId: session.sessionId, status: "completed", title: entry.title, body: entry.titledBody },
  ]);
});
