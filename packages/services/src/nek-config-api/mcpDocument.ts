/** Keep unrelated entries and top-level fields when editing one MCP server. */
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";
import { parseJsonMapping, readTextDocument } from "./documents.js";
import { validationError } from "./errors.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";

type RawMcpServers = Record<string, Record<string, unknown>>;

export async function readMcpServerFile(executor: NekConfigHostExecutor, path: string) {
  const document = await readTextDocument(executor, path);
  const root = document.content === null ? {} : parseJsonMapping(path, document.content);
  const servers = root.mcpServers === undefined ? {} : root.mcpServers;
  if (!isPlainObject(servers)) {
    throw validationError(`${path}: "mcpServers" must be an object`, {
      mcpServers: "must be an object",
    });
  }
  return { revision: document.revision, root, servers };
}

export function serializeMcpServers(servers: Record<string, unknown>, root = {}) {
  return `${JSON.stringify({ ...root, mcpServers: servers }, null, 2)}\n`;
}

/** 供复制到远程使用：读某作用域的 server 对象（不合并）。 */
export async function readRawMcpServers(
  executor: NekConfigHostExecutor,
  path: string,
): Promise<RawMcpServers> {
  const { servers } = await readMcpServerFile(executor, path);
  return Object.fromEntries(
    Object.entries(servers).flatMap(([name, value]) =>
      isPlainObject(value) ? [[name, value]] : [],
    ),
  );
}
