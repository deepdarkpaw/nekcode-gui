import { ZCODE_USER_DATA_DIR_NAME } from "./appDirNames.js";

export type ZCodeAgentBinaryKind = "native-binary";

export interface ZCodeAgentRuntimeDescriptor {
  binaryKind: ZCodeAgentBinaryKind;
  binaryEnvVar: string;
  bundledResourceDir: string;
  version: string;
  spawnArgs: string[];
  nativeConfigDir: string;
  nativeConfigFileName: string;
  missingBinaryMessage: string;
  resolveEntrySegments(platform: string): string[];
}

export function resolvePlatformBinaryName(binaryName: string, platform: string): string {
  return platform === "win32" ? `${binaryName}.exe` : binaryName;
}

export const ZCODE_AGENT_RUNTIME: ZCodeAgentRuntimeDescriptor = {
  binaryKind: "native-binary",
  binaryEnvVar: "GLM_BINARY_PATH",
  bundledResourceDir: "glm",
  version: "0.13.3",
  spawnArgs: ["app-server", "--stdio"],
  nativeConfigDir: `${ZCODE_USER_DATA_DIR_NAME}/cli`,
  nativeConfigFileName: "config.json",
  missingBinaryMessage:
    "[ZCode Agent] glm binary 未找到，请设置 GLM_BINARY_PATH 或先准备 GLM 运行时资源",
  resolveEntrySegments: (platform) => [resolvePlatformBinaryName("zcode-agent", platform)],
};

export function getZCodeAgentRuntime(): ZCodeAgentRuntimeDescriptor {
  return ZCODE_AGENT_RUNTIME;
}
