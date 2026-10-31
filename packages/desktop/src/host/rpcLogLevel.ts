import { ZCODE_AGENT_PROVIDER_NOT_READY_CODE } from "@zcode/shared";

type RpcLogLevel = "debug" | "info" | "warn";

/**
 * host 之前把 RPC 日志统一走 error，主日志里看起来像所有 RPC 都失败了。
 * 这里按消息内容做最小分级：FAIL 记 warn，高频输出轮询成功记 debug，其余记 info。
 */
export function resolveRpcLogLevel(message: string, ...args: unknown[]): RpcLogLevel {
  // 失败日志必须是 warn：曾经把 [rpc:listen] failed 记成 info，正式包里 host 崩溃时
  // 主日志里混在成功流水里，看起来像正常订阅。
  if (message === "[rpc:listen] failed" || message === "[rpc:call] failed") return "warn";

  // 后台详情每秒读取一次，成功日志会持续落盘；只降低该查询的成功级别，保留失败诊断。
  if (message.startsWith("[rpc:call] zcode-agent.backgroundBashOutputV4 OK (")) return "debug";

  // workspace 首次绑定时，provider registry 会在 runtime identity 查询之后同步；
  // 这个明确带错误码的失败是启动握手状态，不是服务降级，避免每个 workspace 都留下一条 warn。
  if (
    message.includes("zcode-session.getWorkspaceRuntimeIdentity FAIL") &&
    args.some(
      (arg) =>
        typeof arg === "object" &&
        arg !== null &&
        "code" in arg &&
        (arg as { code?: unknown }).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
    )
  ) {
    return "info";
  }

  return message.includes(" FAIL ") ? "warn" : "info";
}
