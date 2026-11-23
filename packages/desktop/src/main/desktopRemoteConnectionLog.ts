import type { BrowserWindow } from "electron";
import { PlatformChannels, type RemoteConnectionRuntimeLog } from "@zcode/shared";

export function emitRemoteConnectionLog(
  win: BrowserWindow,
  payload: Pick<RemoteConnectionRuntimeLog, "requestId" | "sessionId" | "level" | "message">,
): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(PlatformChannels.RemoteConnectionLog, {
    label: `window-host-${win.webContents.id}`,
    ...payload,
    source: "window-host-controller",
    timestamp: new Date().toLocaleTimeString(undefined, {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
  });
}
