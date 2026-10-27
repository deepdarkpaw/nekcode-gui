/**
 * nek 0.3.2 当前 builtin tool 镜像。
 *
 * nek 的 `auth_status`/GUI RPC 尚未提供工具列表命令；该列表必须在 host 侧集中维护，
 * 直到 nek 新增 `list_builtin_tools`（或 `get_info` 返回工具目录）后再切换为 RPC 来源。
 */
import type { NekBuiltinTool } from "@zcode/shared/nek-protocol";

export const NEK_BUILTIN_TOOLS: readonly NekBuiltinTool[] = [
  { name: "read" },
  { name: "bash" },
  { name: "edit" },
  { name: "write" },
  { name: "grep" },
  { name: "find" },
  { name: "ls" },
  { name: "ast_grep" },
  { name: "todo_write" },
  { name: "web_search" },
];
