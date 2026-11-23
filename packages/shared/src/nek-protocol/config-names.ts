/**
 * nek v0.5.1: core/model-config.ts, core/model-runtime.ts, core/model-resolver.ts,
 * core/prompt-templates.ts, core/package-manager.ts (auto discovery), and core/skills.ts.
 */
import { isAgentPresetFileName } from "./agent-preset-name.js";
import type { NekResourceType } from "./gui-rpc.js";

export type NekProviderIdError = "required" | "slash" | "edgeWhitespace" | "duplicate";

/** Check a new ID without rewriting it. Exact config keys and the reference prefix differ:
 * nek lowercases both sides of a `provider/model` lookup, but trims only the typed prefix.
 */
export function validateNekProviderId(
  id: unknown,
  existingIds: Iterable<string>,
  previousId?: string,
): NekProviderIdError | null {
  if (typeof id !== "string" || !id.trim()) return "required";
  if (id.includes("/")) return "slash";
  if (id !== id.trim()) return "edgeWhitespace";
  const prefix = id.toLowerCase();
  for (const existing of existingIds) {
    if (existing !== previousId && existing.toLowerCase() === prefix) return "duplicate";
  }
  return null;
}

const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

export type NekResourceNameError =
  | "nameRequired"
  | "promptWhitespace"
  | "promptFilename"
  | "promptHidden"
  | "skillNameLength"
  | "skillCharacters"
  | "skillEdgeHyphen"
  | "skillDoubleHyphen";

/** Rules for new files only. Existing entries and warnings come from `list_resources`. */
export function validateNekResourceName(
  resourceType: NekResourceType,
  name: unknown,
): NekResourceNameError | null {
  if (typeof name !== "string" || name === "") return "nameRequired";
  if (resourceType === "prompts") {
    // expandPromptTemplate matches the non-whitespace token after `/` verbatim.
    if (/\s/u.test(name)) return "promptWhitespace";
    if (!isAgentPresetFileName(name)) return "promptFilename";
    // The GUI writes to an auto-discovery root, where collectAutoPromptEntries skips dotfiles.
    return name.startsWith(".") ? "promptHidden" : null;
  }
  if (name.length > MAX_SKILL_NAME_LENGTH) return "skillNameLength";
  if (!/^[a-z0-9-]+$/.test(name)) return "skillCharacters";
  if (name.startsWith("-") || name.endsWith("-")) return "skillEdgeHyphen";
  return name.includes("--") ? "skillDoubleHyphen" : null;
}

/** Match validateDescription in core/skills.ts, including the length of the untrimmed value. */
export function validateNekSkillDescription(
  description: unknown,
): "descriptionRequired" | "descriptionLength" | null {
  if (typeof description !== "string" || !description.trim()) return "descriptionRequired";
  return description.length > MAX_SKILL_DESCRIPTION_LENGTH ? "descriptionLength" : null;
}
