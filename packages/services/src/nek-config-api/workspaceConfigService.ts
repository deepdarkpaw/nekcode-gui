import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type { INekConfigApi, NekSessionReloadOutcome } from "@zcode/shared/nek-protocol";
import { createServiceDescriptor } from "../descriptors.js";

/** 只暴露资源和项目页所需命令；连接本身决定机器，不接受调用者传 target。 */
export const NEK_WORKSPACE_CONFIG_METHODS = [
  "listConfigResources",
  "setResourceEnabled",
  "createResource",
  "readPromptTemplate",
  "writePromptTemplate",
  "deleteResource",
  "getProjectTrust",
  "setProjectTrust",
  "readSettings",
  "patchSettings",
  "listAvailableModels",
  "readMcpConfig",
  "getMcpStatus",
  "saveMcpServer",
  "setMcpServerOverride",
  "deleteMcpServer",
  "previewMcpImport",
  "testMcpServer",
  "mcpServerAction",
  "listAgentPresets",
  "saveAgentPreset",
  "deleteAgentPreset",
  "readInstructions",
  "writeInstructions",
  "reloadRunningSessions",
] as const satisfies readonly (keyof INekConfigApi)[];
export type NekWorkspaceConfigMethod = (typeof NEK_WORKSPACE_CONFIG_METHODS)[number];

type WorkspaceArgs<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never;
type ConfigChange = Parameters<Parameters<INekConfigApi["watch"]>[1]>[0];

export interface INekWorkspaceConfigService {
  callConfig<M extends NekWorkspaceConfigMethod>(
    method: M,
    ...args: WorkspaceArgs<Parameters<INekConfigApi[M]>>
  ): ReturnType<INekConfigApi[M]>;
  onDynamicConfigChange(cwd?: string): Event<ConfigChange>;
  readonly onDidReload: Event<NekSessionReloadOutcome>;
}

export const INekWorkspaceConfigService = createServiceDescriptor<INekWorkspaceConfigService>(
  ServiceChannels.NekWorkspaceConfig,
);
