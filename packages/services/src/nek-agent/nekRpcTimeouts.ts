import type { NekRpcCommandType } from "@zcode/shared/nek-protocol";

/**
 * 每类命令的等待上限。
 *
 * 关键区分：
 * - `prompt` 只等**受理**（preflight）：nek 一收到就回 `disposition`，模型工作随后才通过事件流推进，
 *   所以这里不能用"跑完一轮"的预算，否则用户每次都要等满超时；
 * - `compact` / `auth_login` / `fetch_provider_models` / `test_provider` / `test_web_search` / `mcp_test`
 *   是真正的长任务（摘要整段上下文、等用户在浏览器里授权、拉远端模型目录、连 MCP server），给长预算；
 * - 其余读写会话状态与配置的命令走默认预算。
 */

/** 默认单命令超时。 */
export const NEK_RPC_DEFAULT_TIMEOUT_MS = 60_000;

/** 按命令类型覆盖的超时表（未列出的走默认值）。 */
export const NEK_RPC_COMMAND_TIMEOUTS_MS: Readonly<Partial<Record<NekRpcCommandType, number>>> = {
  // 受理即返回，但首次 prompt 可能触发模型预检与资源加载。
  prompt: 60_000,
  steer: 30_000,
  follow_up: 30_000,
  abort: 30_000,
  clear_queue: 30_000,
  bash: 60_000,
  abort_bash: 30_000,
  compact: 15 * 60_000,
  new_session: 5 * 60_000,
  switch_session: 5 * 60_000,
  fork: 5 * 60_000,
  clone: 5 * 60_000,
  navigate_tree: 10 * 60_000,
  export_html: 5 * 60_000,
  export_session: 5 * 60_000,
  share_session: 5 * 60_000,
  import_session: 5 * 60_000,
  read_session_snapshot: 2 * 60_000,
  reload: 5 * 60_000,
  validate_config: 2 * 60_000,
  get_changelog: 2 * 60_000,
  get_model_catalog: 2 * 60_000,
  fetch_provider_models: 3 * 60_000,
  test_provider: 3 * 60_000,
  test_web_search: 3 * 60_000,
  mcp_test: 3 * 60_000,
  auth_login: 10 * 60_000,
  auth_status: 2 * 60_000,
  auth_logout: 2 * 60_000,
  delete_session: 2 * 60_000,
  rename_session: 2 * 60_000,
  get_project_trust: 60_000,
  set_project_trust: 60_000,
};

/** 某条命令的等待上限：调用方显式传入的优先，其次命令表，最后每个 client 的默认值。 */
export function resolveNekRpcTimeoutMs(
  command: string,
  overrides?: Readonly<Partial<Record<string, number>>>,
  defaultTimeoutMs?: number,
): number {
  return (
    overrides?.[command] ??
    NEK_RPC_COMMAND_TIMEOUTS_MS[command as NekRpcCommandType] ??
    defaultTimeoutMs ??
    NEK_RPC_DEFAULT_TIMEOUT_MS
  );
}
