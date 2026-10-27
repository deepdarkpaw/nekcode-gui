/**
 * mcp.json 的文档级工具：解析 `mcpServers`、判断"覆盖条目"、序列化。
 *
 * 与 nek `extensions/mcp/config.ts` 一致的判定：没有 `command` / `url` / `type` 的条目是覆盖
 * （只允许 `enabled` / `exposure` / `toolExposure`），其余是完整定义。
 */
import type { NekMcpServerConfig } from "@zcode/shared/nek-protocol";
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";
import { NEK_MCP_OVERRIDE_KEYS } from "../nek-agent/config/schemas.js";
import { parseJsonMapping, readTextDocument } from "./documents.js";
import { validationError } from "./errors.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";

/** 原始 server 表：GUI 不解释的字段原样保留。 */
export type RawMcpServers = Record<string, Record<string, unknown>>;

export const MCP_OVERRIDE_KEYS: readonly string[] = NEK_MCP_OVERRIDE_KEYS;

export function isFullServer(config: Record<string, unknown>): boolean {
  return config.command !== undefined || config.url !== undefined || config.type !== undefined;
}

/** 覆盖条目里出现的非覆盖键（nek 视为错误，不是忽略）。 */
export function overrideKeysOf(config: Record<string, unknown>): string[] {
  return Object.keys(config).filter((key) => !MCP_OVERRIDE_KEYS.includes(key));
}

export function readServerTable(path: string, text: string | null): RawMcpServers {
  if (text === null || text.trim() === "") return {};
  const parsed = parseJsonMapping(path, text);
  const servers = parsed.mcpServers;
  if (servers === undefined) return {};
  if (!isPlainObject(servers)) {
    throw validationError(`${path}: "mcpServers" must be an object`, {
      mcpServers: "must be an object",
    });
  }
  const result: RawMcpServers = {};
  for (const [name, value] of Object.entries(servers)) {
    if (isPlainObject(value)) result[name] = value;
  }
  return result;
}

export async function readMcpServerFile(
  executor: NekConfigHostExecutor,
  path: string,
): Promise<{ revision: string; servers: RawMcpServers }> {
  const document = await readTextDocument(executor, path);
  return { revision: document.revision, servers: readServerTable(path, document.content) };
}

export function serializeMcpServers(servers: RawMcpServers): string {
  return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

/** 供复制到远程使用：读某作用域的全部 server（不合并）。 */
export async function readRawMcpServers(
  executor: NekConfigHostExecutor,
  path: string,
): Promise<RawMcpServers> {
  return (await readMcpServerFile(executor, path)).servers;
}

/** 类型收窄的转发：让调用方拿到契约里的 `NekMcpServerConfig`。 */
export function asServerConfig(
  servers: RawMcpServers,
  name: string,
): NekMcpServerConfig | undefined {
  const value = servers[name];
  return value ? (value as unknown as NekMcpServerConfig) : undefined;
}
