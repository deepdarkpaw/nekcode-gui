import { app, dialog, type BrowserWindow, type NativeImage } from "electron";
import type { Locale } from "@zcode/shared";

/** Keep the native quit confirmation on the current application locale, not the OS locale. */
export function confirmDesktopQuit(options: {
  locale: Locale;
  runningSessionCount: number;
  parentWindow: BrowserWindow | null;
  icon: NativeImage;
}): boolean {
  const { locale, runningSessionCount, parentWindow, icon } = options;
  const appName = app.getName();
  const isZh = locale === "zh-CN";
  const dialogOptions = {
    type: "question" as const,
    buttons: isZh ? ["退出", "取消"] : ["Quit", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    title: isZh ? `退出 ${appName}` : `Quit ${appName}`,
    message: isZh ? `确认退出 ${appName}？` : `Are you sure you want to quit ${appName}?`,
    detail: isZh
      ? `正在进行的会话：${runningSessionCount} 个，退出后会被中断。`
      : `In-progress sessions: ${runningSessionCount}. They will be interrupted after quitting.`,
    icon,
  };
  const response = parentWindow
    ? dialog.showMessageBoxSync(parentWindow, dialogOptions)
    : dialog.showMessageBoxSync(dialogOptions);
  return response === 0;
}
