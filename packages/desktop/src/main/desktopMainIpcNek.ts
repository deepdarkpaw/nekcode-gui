import { BrowserWindow, ipcMain } from "electron";
import {
  NekIpcChannels,
  nekIpcRequestSchema,
  type NekIpcError,
  type NekIpcRequest,
} from "@zcode/shared";
import { createNekConfigHostBridge } from "./desktopMainIpcNekBridge.js";
import { createNekIpcHostRouter } from "./desktopMainIpcNekRouter.js";
import { desktopRemoteInteraction } from "./desktopRemoteReconnect.js";

interface IpcSuccess {
  ok: true;
  value: unknown;
}

interface IpcFailure {
  ok: false;
  error: NekIpcError;
}

type IpcResult = IpcSuccess | IpcFailure;

type IpcLogger = {
  warn: (...args: unknown[]) => void;
};

function serializeError(error: unknown): NekIpcError {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : undefined;
    const message = typeof record.message === "string" ? record.message : undefined;
    const fieldErrors =
      typeof record.fieldErrors === "object" && record.fieldErrors !== null
        ? (record.fieldErrors as Record<string, string>)
        : undefined;
    if (message)
      return { ...(code ? { code } : {}), message, ...(fieldErrors ? { fieldErrors } : {}) };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

function parseRequest(raw: unknown): NekIpcRequest {
  const parsed = nekIpcRequestSchema.safeParse(raw);
  if (!parsed.success) throw new Error("invalid nek IPC request");
  return parsed.data;
}

function eventChannel(scope: "config" | "settings-host" | "remote-interaction"): string {
  switch (scope) {
    case "config":
      return NekIpcChannels.ConfigEvent;
    case "settings-host":
      return NekIpcChannels.SettingsHostEvent;
    case "remote-interaction":
      return NekIpcChannels.RemoteInteractionEvent;
  }
}

/** Main-side registration for all settings, onboarding and remote interaction IPC. */
export function registerNekIpcHandlers(options: IpcLogger): void {
  const remote = desktopRemoteInteraction;
  const bridgePromise = createNekConfigHostBridge(options);
  const routerPromise = bridgePromise.then((bridge) => createNekIpcHostRouter(bridge, remote));
  const requestChannels: Array<{
    channel: string;
    scope: "config" | "settings-host" | "remote-interaction";
  }> = [
    { channel: NekIpcChannels.ConfigInvoke, scope: "config" },
    { channel: NekIpcChannels.SettingsHostInvoke, scope: "settings-host" },
    { channel: NekIpcChannels.RemoteInteractionInvoke, scope: "remote-interaction" },
  ];

  for (const { channel, scope } of requestChannels) {
    ipcMain.handle(channel, async (event, rawRequest: unknown): Promise<IpcResult> => {
      const sender = BrowserWindow.fromWebContents(event.sender)?.webContents ?? event.sender;
      try {
        const request = parseRequest(rawRequest);
        const router = await routerPromise;
        const value = await router.dispatch(scope, request, (payload) => {
          if (!sender.isDestroyed()) sender.send(eventChannel(scope), payload);
        });
        return { ok: true, value };
      } catch (error) {
        options.warn("nek IPC request failed", { scope, error: serializeError(error) });
        return { ok: false, error: serializeError(error) };
      }
    });
  }
}
