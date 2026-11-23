/** nek v0.5.1: extensions/nek/services/agent-types.ts and extensions/nek/prompts/subagent.ts. */
import type { NekAgentPreset, NekAgentPresetEntry } from "./config-types.js";

const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls", "ast_grep", "web_search"];
const DEFAULT_CUSTOM_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "ast_grep",
  "todo_write",
  "web_search",
];
const EXPLORE_INSTRUCTIONS = `Explore the codebase to answer the question in the task prompt. You cannot edit files: report findings, file paths, and code structure instead of changing anything. State the desired depth in your answer: quick, medium, or very thorough.`;

const BUILTIN_AGENT_TYPES: readonly NekAgentPreset[] = [
  {
    name: "generalPurpose",
    description:
      "handles substantial, clearly bounded general work that has already been determined suitable for delegation. It can edit files and run commands. Uncertain search results alone are not enough reason to use it.",
    readonly: false,
    isBackground: false,
    autonomous: false,
    tools: DEFAULT_CUSTOM_TOOL_NAMES,
    disallowedTools: [],
  },
  {
    name: "explorer",
    description:
      "handles clearly bounded, substantial codebase exploration that has already been determined suitable for delegation. It can find files by patterns, search keywords, or map code structure. State the scope and desired depth: quick, medium, or very thorough.",
    readonly: true,
    isBackground: false,
    autonomous: true,
    tools: READ_ONLY_TOOL_NAMES,
    disallowedTools: [],
    instructions: EXPLORE_INSTRUCTIONS,
  },
];

/** nek ignores an empty explicit list, and `readonly` always forces the read-only allowlist first. */
export function effectiveAgentPresetTools(preset: NekAgentPreset): string[] {
  const tools =
    preset.readonly === true
      ? READ_ONLY_TOOL_NAMES
      : preset.tools?.length
        ? preset.tools
        : DEFAULT_CUSTOM_TOOL_NAMES;
  const disallowed = new Set(preset.disallowedTools);
  return tools.filter((tool) => !disallowed.has(tool));
}

export function builtinAgentPresetEntries(): NekAgentPresetEntry[] {
  return BUILTIN_AGENT_TYPES.map((type) => ({
    source: "builtin",
    revision: "builtin",
    preset: { ...type, tools: [...(type.tools ?? [])], disallowedTools: [] },
    effectiveTools: effectiveAgentPresetTools(type),
  }));
}

/** Input is in nek discovery order. Keep the losing files visible so users can edit them. */
export function annotateAgentPresetOverrides(
  entries: readonly NekAgentPresetEntry[],
): NekAgentPresetEntry[] {
  const winnerByName = new Map<string, NekAgentPresetEntry>();
  for (const entry of entries) {
    if (!entry.untrusted) winnerByName.set(entry.preset.name, entry);
  }
  return entries.map((entry) => {
    const winner = winnerByName.get(entry.preset.name);
    return !entry.untrusted && winner !== entry && winner?.path
      ? { ...entry, overriddenBy: winner.path }
      : entry;
  });
}
