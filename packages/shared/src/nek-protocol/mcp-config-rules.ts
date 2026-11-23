/** nek v0.5.1: core/mcp-servers.ts (server validation) and extensions/mcp/config.ts (project overrides). */
export const NEK_MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Validate the raw key, without trimming or folding it. */
export function isNekMcpServerName(name: unknown): name is string {
  return typeof name === "string" && NEK_MCP_SERVER_NAME_PATTERN.test(name);
}
