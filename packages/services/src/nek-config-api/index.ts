/**
 * 设置中心的真实后端：`NekConfigApi implements INekConfigApi`。
 *
 * 只做逻辑与进程通信，不含任何 UI。底层复用 `nek-agent/config` 的文档规则
 * （revision、`.tmp` + rename、与 nek 共用的 settings 锁）与控制进程 RPC。
 *
 * 目录按功能拆分（单个文件不超过 lint 的 400 行上限）：
 * - `errors.ts`：`NekConfigError` 形状与错误映射；
 * - `hostExecutor.ts`：目标机器执行器接口 + 本机实现 + 内存假实现；
 * - `revision.ts`：`mtime + size + sha256` 组成的 revision 令牌；
 * - `documents.ts`：读快照、原子写、revision 校验等文档级原语；
 * - 其余按配置文件分组（models / settings / mcp / yaml / presets / resources）。
 */
export const NEK_CONFIG_API_MODULE = "nek-config-api";
