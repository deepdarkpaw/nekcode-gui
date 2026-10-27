/**
 * nek 内置工具镜像（`listBuiltinTools` 的数据源）。
 *
 * 来源：nek `packages/coding-agent/src/core/tool-names.ts`（v0.4.0）里的
 * `ToolName` / `allToolNames` / `DEFAULT_ACTIVE_TOOL_NAMES`。
 *
 * 为什么在 host 侧维护：nek 的 GUI RPC 没有 `list_builtin_tools`，`get_info` 也不返回工具目录，
 * 而设置页要渲染 `defaultTools` 勾选框，必须知道"有哪些工具、哪些默认启用"。镜像集中在这一处；
 * nek 提供 `list_builtin_tools` 后，把 `listBuiltinTools` 换成 RPC 结果并删除本文件。
 */
import type { NekBuiltinTool } from "@zcode/shared/nek-protocol";

/** 与 `allToolNames` 一致，顺序即 nek 的枚举顺序。 */
const ALL_TOOL_NAMES = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "ast_grep",
  "web_search",
] as const;

/** 与 `DEFAULT_ACTIVE_TOOL_NAMES` 一致（`powershell` 默认关闭）。 */
const DEFAULT_ACTIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "ast_grep",
  "web_search",
]);

const DESCRIPTIONS: Readonly<Record<string, string>> = {
  read: "Read a file",
  bash: "Run a shell command",
  powershell: "Run a PowerShell command",
  edit: "Edit a file",
  write: "Write a file",
  grep: "Search file contents",
  find: "Find files by name",
  ls: "List a directory",
  ast_grep: "Search code by syntax tree",
  web_search: "Search the web",
};

/** 每次调用返回副本，调用方改动不会污染镜像。 */
export function listBuiltinTools(): NekBuiltinTool[] {
  return ALL_TOOL_NAMES.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    defaultActive: DEFAULT_ACTIVE_TOOL_NAMES.has(name),
  }));
}
