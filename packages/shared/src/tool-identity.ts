export const ZCODE_KNOWN_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "ApplyPatch",
  "Bash",
  "Glob",
  "Grep",
  "ls",
  "WebFetch",
  "WebSearch",
  "web_search",
  "TodoRead",
  "TodoWrite",
  "GoalRead",
  "ReadSessionContext",
  "AskUserQuestion",
  "SendMessage",
  "RespondToCoordinator",
  "TaskOutput",
  "TaskStop",
  "js",
  "js_reset",
  "js_add_node_module_dir",
  "mcp__node_repl__js",
  "mcp__node_repl__js_reset",
  "mcp__node_repl__js_add_node_module_dir",
  "Agent",
  "Task",
  "Skill",
  // nek 原生工具。未登记时 UI identity 会退回 unknown / legacy 启发式，
  // `create_plan` 被当成文件写入、`update_plan` 被当成 todo，
  // 其余工具直接落到 raw fallback 卡把原始参数 JSON 摊进聊天区。
  "subagent",
  "powershell",
  "find",
  "ast_grep",
  "tool_search",
  "await",
  "stop_subagent",
  "create_plan",
  "update_plan",
  "switch_mode",
  "read_mcp_resource",
  "list_mcp_resources",
  "list_mcp_resource_templates",
] as const;

export type ZCodeKnownToolName = (typeof ZCODE_KNOWN_TOOL_NAMES)[number];

export type ZCodeToolFamily =
  | "file-read"
  | "file-write"
  | "shell"
  | "search"
  | "todo"
  | "ask-user-question"
  | "agent"
  | "skill"
  | "goal"
  | "session-context"
  | "message"
  | "task-control"
  | "nek-control"
  | "node-repl";

const TOOL_FAMILY_BY_NAME: Record<ZCodeKnownToolName, ZCodeToolFamily> = {
  Read: "file-read",
  Write: "file-write",
  Edit: "file-write",
  ApplyPatch: "file-write",
  Bash: "shell",
  Glob: "search",
  Grep: "search",
  ls: "search",
  WebFetch: "search",
  WebSearch: "search",
  web_search: "search",
  TodoRead: "todo",
  TodoWrite: "todo",
  GoalRead: "goal",
  ReadSessionContext: "session-context",
  AskUserQuestion: "ask-user-question",
  SendMessage: "message",
  RespondToCoordinator: "message",
  TaskOutput: "task-control",
  // TaskStop 未登记时 UI identity 会退回 unknown，最终落到 raw fallback renderer。
  TaskStop: "task-control",
  js: "node-repl",
  js_reset: "node-repl",
  js_add_node_module_dir: "node-repl",
  // node_repl 由 MCP 暴露，进入 UI 的工具名因此带 MCP 前缀。
  // 若这里只登记旧 built-in 名称，专用 REPL renderer 会退回 unknown fallback。
  mcp__node_repl__js: "node-repl",
  mcp__node_repl__js_reset: "node-repl",
  mcp__node_repl__js_add_node_module_dir: "node-repl",
  Agent: "agent",
  Task: "agent",
  Skill: "skill",
  // nek 子代理编排与运行时控制工具：统一走单行语义摘要，
  // 不能让它们落进 fallback / file-write / todo 的任何启发式分支。
  subagent: "agent",
  powershell: "shell",
  find: "search",
  ast_grep: "search",
  tool_search: "nek-control",
  await: "nek-control",
  stop_subagent: "nek-control",
  create_plan: "nek-control",
  update_plan: "nek-control",
  switch_mode: "nek-control",
  read_mcp_resource: "nek-control",
  list_mcp_resources: "nek-control",
  list_mcp_resource_templates: "nek-control",
};

const TOOL_NAME_BY_LOWER = new Map<string, ZCodeKnownToolName>(
  ZCODE_KNOWN_TOOL_NAMES.map((toolName) => [toolName.toLowerCase(), toolName]),
);

export function normalizeZCodeToolName(
  value: string | null | undefined,
): ZCodeKnownToolName | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  return TOOL_NAME_BY_LOWER.get(normalized.toLowerCase()) ?? null;
}

export function getZCodeToolFamilyForName(
  value: string | null | undefined,
): ZCodeToolFamily | null {
  const toolName = normalizeZCodeToolName(value);
  return toolName ? TOOL_FAMILY_BY_NAME[toolName] : null;
}

export function isZCodeToolFamily(
  value: string | null | undefined,
  family: ZCodeToolFamily,
): boolean {
  return getZCodeToolFamilyForName(value) === family;
}

export function isZCodeFileContentWriteToolName(value: string | null | undefined): boolean {
  return normalizeZCodeToolName(value) === "Write";
}
