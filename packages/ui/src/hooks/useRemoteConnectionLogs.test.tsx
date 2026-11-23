// @vitest-environment happy-dom
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it } from "vitest";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteConnectionLogMessage } from "./useRemoteConnectionLogs.js";

afterEach(cleanup);

it.each([
  {
    locale: "zh-CN",
    connecting: "正在通过窗口宿主连接 SSH 工作区",
    connected: "已连接到远程 Docker 工作区",
    disconnected: "远程工作区连接已断开：Connection reset",
  },
  {
    locale: "en-US",
    connecting: "Connecting to the SSH workspace through the window host",
    connected: "Connected to the remote Docker workspace",
    disconnected: "The remote workspace disconnected: Connection reset",
  },
] as const)("ZR-6 renders structured remote lifecycle logs in $locale", (entry) => {
  const { result } = renderHook(() => useZCodeIntl().intl, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <ZCodeIntlProvider initialLocale={entry.locale}>{children}</ZCodeIntlProvider>
    ),
  });
  const intl = result.current;
  expect(formatRemoteConnectionLogMessage({ code: "connecting", targetKind: "ssh" }, intl)).toBe(
    entry.connecting,
  );
  expect(formatRemoteConnectionLogMessage({ code: "connected", targetKind: "docker" }, intl)).toBe(
    entry.connected,
  );
  expect(
    formatRemoteConnectionLogMessage({ code: "disconnected", detail: "Connection reset" }, intl),
  ).toBe(entry.disconnected);
  expect(formatRemoteConnectionLogMessage("[SSH] Connection reset", intl)).toBe("Connection reset");
});
