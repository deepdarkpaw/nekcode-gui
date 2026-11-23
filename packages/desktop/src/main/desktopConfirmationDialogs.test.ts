import { app, dialog, type NativeImage } from "electron";
import { expect, it, vi } from "vitest";
import { confirmDesktopQuit } from "./desktopConfirmationDialogs.js";

vi.mock("electron", () => ({
  app: { getName: vi.fn() },
  dialog: { showMessageBoxSync: vi.fn() },
}));

it.each([
  {
    locale: "zh-CN",
    appName: "nekcode",
    title: "退出 nekcode",
    message: "确认退出 nekcode？",
    detail: "正在进行的会话：2 个，退出后会被中断。",
    buttons: ["退出", "取消"],
  },
  {
    locale: "en-US",
    appName: "nekcode-preview",
    title: "Quit nekcode-preview",
    message: "Are you sure you want to quit nekcode-preview?",
    detail: "In-progress sessions: 2. They will be interrupted after quitting.",
    buttons: ["Quit", "Cancel"],
  },
] as const)("ZR-1 quit confirmation uses the runtime app name in $locale", (entry) => {
  vi.mocked(app.getName).mockReturnValue(entry.appName);
  vi.mocked(dialog.showMessageBoxSync).mockReturnValue(1);

  expect(
    confirmDesktopQuit({
      locale: entry.locale,
      runningSessionCount: 2,
      parentWindow: null,
      icon: {} as NativeImage,
    }),
  ).toBe(false);
  expect(dialog.showMessageBoxSync).toHaveBeenLastCalledWith(
    expect.objectContaining({
      title: entry.title,
      message: entry.message,
      detail: entry.detail,
      buttons: entry.buttons,
      defaultId: 1,
      cancelId: 1,
    }),
  );
});
