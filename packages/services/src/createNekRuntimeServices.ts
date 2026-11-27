import {
  createNekAgentServiceAdapter,
  type NekAgentServiceAdapterOptions,
} from "./nek-agent/index.js";
import {
  NekConfigApi,
  createLocalNekConfigTargetHost,
  nekConfigApiConfigFromRuntime,
  type NekConfigApiOptions,
} from "./nek-config-api/index.js";

/** Shared production composition for desktop hosts and remote gui-server (each owns local CLI writers). */
export function createNekRuntimeServices(
  options: {
    agent?: Omit<NekAgentServiceAdapterOptions, "modelRuntime">;
    config?: NekConfigApiOptions;
  } = {},
) {
  const configOptions = options.config ?? { hosts: createLocalNekConfigTargetHost() };
  const configApi = new NekConfigApi({
    ...configOptions,
    config: nekConfigApiConfigFromRuntime(options.agent?.runtimeConfig ?? {}, configOptions.config),
  });
  configApi.observeAnnouncements({ kind: "local" });
  const agentService = createNekAgentServiceAdapter({
    ...options.agent,
    modelRuntime: configApi.modelRuntime({ kind: "local" }),
  });
  return { configApi, agentService };
}
