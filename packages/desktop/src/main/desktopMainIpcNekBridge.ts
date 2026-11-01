import { homedir } from "node:os";
import { join } from "node:path";
import type { INekConfigApi, INekSettingsHostApi, NekRemoteHost } from "@zcode/shared/nek-protocol";
import {
  createLocalNekConfigTargetHost,
  NekConfigApi,
  nekConfigApiConfigFromRuntime,
} from "../../../services/src/nek-config-api/index.js";
import { loadGuiRuntimeConfig } from "../../../services/src/nek-agent/guiRuntimeConfigLoader.js";
import { NekSettingsHostService } from "./desktopMainIpcNekHost.js";

export interface NekConfigHostBridge {
  configApi: INekConfigApi;
  hostApi: INekSettingsHostApi;
  dispose(): void;
}

function targetInfoOf(host: NekRemoteHost) {
  return {
    connectionId: host.connectionId,
    label: host.alias,
    hostname: host.alias,
    connected: host.state === "connected",
    nek: host.nek,
  };
}

/**
 * Builds the one settings owner for a desktop process. Config documents and onboarding state
 * are owned here; renderer clients only see the contract-shaped adapters below the IPC boundary.
 */
export async function createNekConfigHostBridge(logger: {
  warn: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}): Promise<NekConfigHostBridge> {
  const hostApi = new NekSettingsHostService();
  const loaded = await loadGuiRuntimeConfig([
    { path: join(process.cwd(), "config", "config.yaml"), label: "bundled" },
    { path: join(homedir(), ".nek", "gui", "config.yaml"), label: "user" },
  ]);
  for (const diagnostic of loaded.diagnostics)
    logger.warn("invalid GUI runtime config", diagnostic);
  const hosts = createLocalNekConfigTargetHost({
    remotes: {
      list: async () => (await hostApi.listHosts()).map(targetInfoOf),
      executor: (connectionId) => hostApi.configExecutor(connectionId),
    },
  });
  const configApi = new NekConfigApi({
    hosts,
    forwardLoginPorts: (target, ports) => hostApi.forwardLoginPorts(target, ports),
    config: nekConfigApiConfigFromRuntime(loaded.config),
    logger,
  });
  return {
    configApi,
    hostApi,
    dispose: () => {
      configApi.dispose();
      hostApi.dispose();
    },
  };
}
