/**
 * nek 扩展（plan / todo / subagent）与 MCP 经 `extension_call` / `extension_event` 暴露的类型。
 *
 * 与 `gui-rpc.ts` 分开只为控制文件长度；两者一起通过 `@zcode/shared/nek-protocol` 导出。
 */
import type { NekThinkingLevel } from "./gui-rpc.js";

// ============================================================================
// nek 扩展（plan / todo / subagent）经 extension_call 与 extension_event 暴露
// ============================================================================

export type NekMode = "agent" | "plan";

export interface NekTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface NekPlanSummary {
  path: string;
  name: string;
  overview: string;
  revision: number;
  status: "draft" | "ready";
  todos: Array<{ id: string; content: string }>;
}

export interface NekSubagentRecord {
  id: string;
  description: string;
  type: string;
  background: boolean;
  status: "running" | "completed" | "errored" | "aborted";
  model?: string;
  activity?: string;
  usage?: { input: number; output: number };
  /** epoch ms。 */
  startedAt: number;
  endedAt?: number;
  lastActivityAt?: number;
  sessionFile?: string;
  error?: string;
  /** 截断到 4 KB。 */
  finalText?: string;
}

export interface NekAgentTypeInfo {
  name: string;
  description: string;
  source: "builtin" | "user" | "project";
  readonly: boolean;
  background: boolean;
  autonomous: boolean;
  model?: string;
  thinking?: NekThinkingLevel;
}

export interface NekState {
  mode: NekMode;
  todos: NekTodo[];
  plans: NekPlanSummary[];
  activePlanPath?: string;
  subagents: NekSubagentRecord[];
}

/** extension_call 方法名 → params / result。 */
export interface NekExtensionMethods {
  "nek.get_state": { params: undefined; result: NekState };
  "nek.set_mode": { params: { mode: NekMode }; result: NekState };
  "nek.stop_subagent": { params: { id: string }; result: { status: NekSubagentRecord["status"] } };
  "nek.get_subagent_transcript": { params: { id: string }; result: { messages: unknown[] } };
  "nek.list_agent_types": { params: undefined; result: { types: NekAgentTypeInfo[] } };
  "nek.get_plan": { params: { path: string }; result: NekPlanSummary & { markdown: string } };
  "mcp.status": { params: undefined; result: { servers: NekMcpServerStatus[] } };
  "mcp.reconnect": { params: { name: string }; result: { server: NekMcpServerStatus } };
  "mcp.login": { params: { name: string }; result: { server: NekMcpServerStatus } };
  "mcp.logout": { params: { name: string }; result: { server: NekMcpServerStatus } };
}

/** extension_event 名称 → payload。 */
export interface NekExtensionEvents {
  /** 模式、todos、计划变化时发送完整快照。 */
  "nek.state": NekState;
  /** 单个子代理的增量（含后台进度）；同一子代理节流到每秒最多 10 次。 */
  "nek.subagent": NekSubagentRecord;
  "mcp.status_changed": { servers: NekMcpServerStatus[] };
}

// ============================================================================
// MCP
// ============================================================================

export type NekMcpExposure = "deferred" | "direct" | "hidden";

/** mcp.json `mcpServers.<name>` 的形状（nek `core/mcp-servers.ts`）。 */
export type NekMcpServerConfig = {
  description?: string;
  enabled?: boolean;
  exposure?: NekMcpExposure;
  toolExposure?: Record<string, NekMcpExposure>;
  /** 秒，默认 60。 */
  timeout?: number;
} & (
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | {
      type?: "http";
      url: string;
      headers?: Record<string, string>;
      oauth?: {
        clientId?: string;
        clientSecret?: string;
        callbackPort?: number;
        callbackUrl?: string;
        scope?: string;
        clientName?: string;
        authServerMetadataUrl?: string;
      };
    }
);

export interface NekMcpServerStatus {
  name: string;
  scope: "global" | "project";
  transport: "stdio" | "http";
  enabled: boolean;
  exposure: NekMcpExposure;
  state: "disabled" | "connecting" | "connected" | "failed" | "needs_auth";
  error?: string;
  tools: Array<{ name: string; exposure: NekMcpExposure }>;
  auth?: { required: boolean; loggedIn: boolean };
}
