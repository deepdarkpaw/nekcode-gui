/**
 * mock 的内置工具清单（与 services 的 `builtinTools.ts` 镜像一致）。
 *
 * 单独成文件是为了让 `mockSeed.ts` 保持在 400 行以内；内容改动时两处要一起改。
 */
import type { NekBuiltinTool } from "@zcode/shared/nek-protocol";

export const MOCK_BUILTIN_TOOLS: NekBuiltinTool[] = [
  { name: "read", defaultActive: true },
  { name: "bash", defaultActive: true },
  { name: "powershell", defaultActive: false },
  { name: "edit", defaultActive: true },
  { name: "write", defaultActive: true },
  { name: "grep", defaultActive: true },
  { name: "find", defaultActive: true },
  { name: "ls", defaultActive: true },
  { name: "ast_grep", defaultActive: true },
  { name: "web_search", defaultActive: true },
];
