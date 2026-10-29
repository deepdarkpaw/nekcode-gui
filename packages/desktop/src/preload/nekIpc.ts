import { ipcRenderer } from "electron";
import { NekIpcChannels } from "@zcode/shared";
import type { NekIpcRequest } from "@zcode/shared";

type EventListener = (payload: unknown) => void;

export interface NekIpcPreloadBridge {
  configInvoke(request: NekIpcRequest): Promise<unknown>;
  onConfigEvent(listener: EventListener): () => void;
  settingsHostInvoke(request: NekIpcRequest): Promise<unknown>;
  onSettingsHostEvent(listener: EventListener): () => void;
  remoteInteractionInvoke(request: NekIpcRequest): Promise<unknown>;
  onRemoteInteractionEvent(listener: EventListener): () => void;
}

function invoke(channel: string, request: NekIpcRequest): Promise<unknown> {
  return ipcRenderer.invoke(channel, request);
}

function listen(channel: string, listener: EventListener): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

export function createNekIpcPreloadBridge(): NekIpcPreloadBridge {
  return {
    configInvoke: (request) => invoke(NekIpcChannels.ConfigInvoke, request),
    onConfigEvent: (listener) => listen(NekIpcChannels.ConfigEvent, listener),
    settingsHostInvoke: (request) => invoke(NekIpcChannels.SettingsHostInvoke, request),
    onSettingsHostEvent: (listener) => listen(NekIpcChannels.SettingsHostEvent, listener),
    remoteInteractionInvoke: (request) => invoke(NekIpcChannels.RemoteInteractionInvoke, request),
    onRemoteInteractionEvent: (listener) => listen(NekIpcChannels.RemoteInteractionEvent, listener),
  };
}
