/** nek v0.5.1: utils/frontmatter.ts and extensions/nek/services/agent-types.ts (readAgentFile). */
import { parse as parseYaml } from "yaml";
import { NEK_THINKING_LEVELS, type NekAgentPreset } from "@zcode/shared/nek-protocol";
import { serializeFrontmatterDocument, stripBom } from "./nekConfigDocuments.js";
import { NekConfigParseError } from "./nekConfigFs.js";

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function readTools(value: unknown): string[] | undefined {
  const list: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const names = list.flatMap((item) => readString(item) ?? []);
  return names.length ? names : undefined;
}

export function decodeAgentFrontmatter(path: string, value: unknown): NekAgentPreset {
  if (typeof value !== "object" || value === null)
    throw new NekConfigParseError(path, "frontmatter must be a mapping");
  const fields = value as Record<string, unknown>;
  const name = readString(fields.name);
  const description = readString(fields.description);
  if (!name || !description)
    throw new NekConfigParseError(path, 'frontmatter needs both "name" and "description"');
  const thinking = NEK_THINKING_LEVELS.find((level) => level === readString(fields.thinking));
  if (fields.thinking !== undefined && !thinking)
    throw new NekConfigParseError(
      path,
      `"thinking" must be one of ${NEK_THINKING_LEVELS.join(", ")}`,
    );
  const contextWindow = fields.context_window;
  if (
    contextWindow !== undefined &&
    !(typeof contextWindow === "number" && Number.isSafeInteger(contextWindow) && contextWindow > 0)
  )
    throw new NekConfigParseError(path, '"context_window" must be a positive integer');
  return {
    name,
    description,
    model: readString(fields.model),
    thinking,
    contextWindow,
    readonly: readBoolean(fields.readonly),
    isBackground: readBoolean(fields.is_background),
    autonomous: readBoolean(fields.autonomous),
    tools: readTools(fields.tools),
    disallowedTools: readTools(fields.disallowed_tools),
  };
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Read with nek's parser rules, while retaining the original body for frontmatter-only edits. */
export function parseAgentMarkdown(path: string, text: string) {
  const withoutBom = stripBom(text);
  // Find nek's first `\n---` in the original text to also preserve the exact body bytes.
  const delimiter = /(?:\r\n?|\n)---/gu;
  delimiter.lastIndex = 3;
  const end = withoutBom.startsWith("---") ? delimiter.exec(withoutBom) : null;
  let value: unknown;
  try {
    const header = end ? withoutBom.slice(0, end.index).replace(/\r\n?/gu, "\n").slice(4) : "";
    value = header ? (parseYaml(header) ?? {}) : {};
  } catch (error) {
    throw new NekConfigParseError(path, error instanceof Error ? error.message : String(error));
  }
  const fields = decodeAgentFrontmatter(path, value);
  const bodySuffix = end ? withoutBom.slice(end.index + end[0].length) : "";
  const body = bodySuffix.replace(/\r\n?/gu, "\n").trim();
  const preset: NekAgentPreset = { ...fields, instructions: body || undefined };
  return { preset, frontmatter: value as Record<string, unknown>, body, bodySuffix };
}

function encodeFields(preset: NekAgentPreset): Record<string, unknown> {
  return {
    name: preset.name,
    description: preset.description,
    model: preset.model,
    thinking: preset.thinking,
    context_window: preset.contextWindow,
    readonly: preset.readonly,
    tools: preset.tools,
    disallowed_tools: preset.disallowedTools,
    is_background: preset.isBackground,
    autonomous: preset.autonomous,
  };
}

/** Patch only changed fields. Untouched YAML values (including strings vs. lists) stay as authored. */
export function serializeAgentMarkdown(
  path: string,
  preset: NekAgentPreset,
  existing?: ReturnType<typeof parseAgentMarkdown>,
): string {
  const fields = encodeFields(preset);
  decodeAgentFrontmatter(path, fields);
  const frontmatter = { ...existing?.frontmatter };
  const oldFields = existing && encodeFields(existing.preset);
  for (const [key, value] of Object.entries(fields)) {
    if (JSON.stringify(value) === JSON.stringify(oldFields?.[key])) continue;
    if (value === undefined) delete frontmatter[key];
    else frontmatter[key] = value;
  }
  if (existing && (preset.instructions ?? "") === existing.body)
    return `${serializeFrontmatterDocument(frontmatter, "").slice(0, -1)}${existing.bodySuffix}`;
  return serializeFrontmatterDocument(frontmatter, preset.instructions ?? "");
}
