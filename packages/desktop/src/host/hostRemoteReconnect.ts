import { homedir } from "node:os";
import { join } from "node:path";
import { remoteDesktopMessageSchema, type RemoteTarget } from "@zcode/shared";
import { loadGuiRuntimeConfig } from "../../../services/src/nek-agent/guiRuntimeConfigLoader.js";
import {
  createReconnectingRemoteConnection,
  type RemoteReconnectControls,
} from "./reconnectingRemoteConnection.js";
import type { WindowRemoteConnectionHandle } from "./windowRemoteConnectionRegistry.js";

/** Window Host command routing owns no retry state; it delegates to the entry's adapter. */
export function createHostRemoteReconnect(
  port: {
    on(event: "message", listener: (event: { data: unknown }) => void): unknown;
    postMessage(message: unknown): void;
  },
  warn: (...args: unknown[]) => void,
) {
  const adapters = new Map<string, RemoteReconnectControls>();
  port.on("message", ({ data }) => {
    const parsed = remoteDesktopMessageSchema.safeParse(data);
    if (!parsed.success || parsed.data.type !== "remote-reconnect-command") return;
    const adapter = adapters.get(parsed.data.connectionId);
    if (!adapter) return;
    if (parsed.data.action === "retry") adapter.retryNow();
    else adapter.cancelReconnect();
  });
  const loaded = loadGuiRuntimeConfig([
    { path: join(process.cwd(), "config", "config.yaml"), label: "bundled" },
    { path: join(homedir(), ".nek", "gui", "config.yaml"), label: "user" },
  ]).then((result) => {
    for (const diagnostic of result.diagnostics) warn("invalid GUI runtime config", diagnostic);
    return result.config;
  });
  return async <TServices, TCapabilities>(
    request: { target: RemoteTarget; signal: AbortSignal },
    connect: (
      signal: AbortSignal,
    ) => Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>>,
  ) => {
    const config = await loaded;
    return createReconnectingRemoteConnection({
      ...request,
      connect,
      backoffSeconds: config.remote.reconnectBackoffSeconds,
      emit: (event) => port.postMessage({ type: "remote-connection-status", event }),
      attachReconnectAdapter: (connectionId, adapter) => {
        adapters.set(connectionId, adapter);
        return () => {
          if (adapters.get(connectionId) === adapter) adapters.delete(connectionId);
        };
      },
    });
  };
}
