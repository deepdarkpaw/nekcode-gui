/**
 * 设置中心的真实后端：`NekConfigApi implements INekConfigApi`。
 *
 * 只做逻辑与进程通信，不含任何 UI。底层复用 `nek-agent/config` 的文档规则
 * （revision、`.tmp` + rename、与 nek 共用的 settings 锁）与控制进程 RPC。
 *
 * 文件划分（单个文件不超过 lint 的 400 行上限）：
 * - `errors.ts` / `revision.ts` / `documents.ts` / `paths.ts`：错误形状、revision 令牌、读写原语；
 * - `hostExecutor.ts`：目标机器执行器（本机 Node fs + 内存假实现）；
 * - `runtime.ts`：目标解析、控制进程缓存、监视、写后重载；
 * - `modelsDocument.ts` / `modelsReferences.ts` / `modelsApi.ts`：models.json 的注释保留编辑与改名；
 * - `settingsDefaults.ts` / `settingsDocument.ts` / `settingsApi.ts`：settings.json（复用 nek 的锁）；
 * - `presetsDocument.ts` / `agentApi.ts`：子代理预设、指令文件、资源清单；
 * - `mcpApi.ts` / `yamlApi.ts` / `controlApi.ts` / `copyApi.ts` / `login.ts`：其余配置文件与进程能力；
 * - `nekConfigApi.ts`：把上面拼成 `INekConfigApi`。
 */
export { NekConfigApi } from "./nekConfigApi.js";
export { NekConfigError } from "./errors.js";
export type { NekConfigErrorShape } from "./errors.js";
export {
  createLocalNekConfigHostExecutor,
  createMemoryNekConfigHostExecutor,
  resolveAgentDir,
} from "./hostExecutor.js";
export type {
  LocalNekConfigHostExecutorOptions,
  MemoryNekConfigHostExecutor,
  MemoryNekConfigHostExecutorOptions,
  NekConfigHostExecutor,
  NekHostDirEntry,
  NekHostLock,
} from "./hostExecutor.js";
export { createLocalNekConfigTargetHost, localNekState } from "./localTargetHost.js";
export type { CreateLocalTargetHostOptions, NekConfigRemoteHosts } from "./localTargetHost.js";
export { createNekControlClient } from "./control.js";
export type { NekControlClient, NekControlClientLogger, NekStructuredHandler } from "./control.js";
export type {
  NekConfigApiConfig,
  NekConfigApiLogger,
  NekConfigApiOptions,
  NekLoginPortForward,
  NekConfigSessionHandle,
  NekConfigSessionRegistry,
  NekConfigTargetHost,
  NekReloadOutcome,
} from "./runtime.js";
export { NekConfigRuntime, nekConfigApiConfigFromRuntime, targetKeyOf } from "./runtime.js";
export { ABSENT_REVISION, encodeRevision, sameRevision } from "./revision.js";
export type { NekHostStat, NekRevisionParts } from "./revision.js";
export { NEK_SETTINGS_DEFAULTS, COMPACTION_CONTENT_DEFAULTS } from "./settingsDefaults.js";
export { NEK_YAML_DEFAULTS } from "./yamlApi.js";
export { BUILTIN_PRESETS, BUILTIN_PRESET_REVISION } from "./presetsDocument.js";
export { BUILTIN_PROVIDER_IDS, maskApiKey, apiKeyView } from "./modelsDocument.js";
export { LOGIN_CALLBACK_PORTS } from "./login.js";
export { copyItemKey } from "./copyApi.js";
export { CONFIG_FILE_NAMES } from "./watchFiles.js";
export { readRawMcpServers, serializeMcpServers } from "./mcpDocument.js";
export type { RawMcpServers } from "./mcpDocument.js";
