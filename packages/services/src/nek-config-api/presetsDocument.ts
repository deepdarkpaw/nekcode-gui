/**
 * 子代理预设（`agents/*.md`）：frontmatter + 正文。
 *
 * 三种来源（`builtin` / `user` / `project`）与 nek 的 `discoverAgentTypes` 对齐：
 * 内置预设来自 nek 代码（只读、无文件），用户与项目预设是 `<agentDir>/agents/*.md`
 * 与 `<cwd>/.nek/agents/*.md`。保存时保留未知 frontmatter 键与正文原文。
 */
import type { NekAgentPreset, NekAgentPresetEntry, NekConfigScope } from "@zcode/shared/nek-protocol";
import {
  isPlainObject,
  parseFrontmatterDocument,
  serializeFrontmatterDocument,
} from "../nek-agent/config/nekConfigDocuments.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import { readTextDocument, writeTextDocument } from "./documents.js";
import { conflict, validationError } from "./errors.js";
import { ABSENT_REVISION, sameRevision } from "./revision.js";
import { agentsDir, agentPresetPath } from "./paths.js";

/** nek `BUILTIN_AGENT_TYPES` 的只读镜像（正文与工具列表以 nek 为准，这里不重复抄提示词）。 */
export const BUILTIN_PRESETS: readonly NekAgentPreset[] = [
  {
    name: "generalPurpose",
    description:
      "handles substantial, clearly bounded general work that has already been determined suitable for delegation. It can edit files and run commands.",
    readonly: false,
    isBackground: false,
    autonomous: false,
    tools: [
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
    ],
    disallowedTools: [],
    instructions: "",
  },
  {
    name: "explorer",
    description:
      "handles clearly bounded, substantial codebase exploration. It can find files by patterns, search keywords, or map code structure.",
    readonly: true,
    isBackground: false,
    autonomous: true,
    tools: ["read", "grep", "find", "ls", "ast_grep", "web_search"],
    disallowedTools: [],
    instructions: "",
  },
];

/** 内置预设的 revision 令牌：不是文件，但契约要求每个条目都带 revision。 */
export const BUILTIN_PRESET_REVISION = "builtin";

/** 预设文件名：与 nek 的 `*.md` 扫描一致，只允许安全字符。 */
const PRESET_NAME_PATTERN = /^[A-Za-z0-9._-]+$/u;

export interface NekAgentPresetFile {
  path: string;
  revision: string;
  /** frontmatter 原始对象（含 GUI 不认识的键）。 */
  frontmatter: Record<string, unknown>;
  body: string;
  preset: NekAgentPreset;
}

export function presetToFrontmatter(preset: NekAgentPreset): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {
    name: preset.name,
    description: preset.description,
  };
  if (preset.model !== undefined) frontmatter.model = preset.model;
  if (preset.thinking !== undefined) frontmatter.thinking = preset.thinking;
  if (preset.contextWindow !== undefined) frontmatter.context_window = preset.contextWindow;
  if (preset.readonly !== undefined) frontmatter.readonly = preset.readonly;
  if (preset.tools !== undefined) frontmatter.tools = [...preset.tools];
  if (preset.disallowedTools !== undefined) frontmatter.disallowed_tools = [...preset.disallowedTools];
  if (preset.isBackground !== undefined) frontmatter.is_background = preset.isBackground;
  if (preset.autonomous !== undefined) frontmatter.autonomous = preset.autonomous;
  return frontmatter;
}

function readStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (typeof value === "string") {
    const list = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}

/** frontmatter + 正文 → 契约里的预设形状。 */
export function frontmatterToPreset(
  path: string,
  frontmatter: Record<string, unknown>,
  body: string,
): NekAgentPreset {
  const name = typeof frontmatter.name === "string" ? frontmatter.name : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  if (name === "" || description === "") {
    throw validationError(`${path}: frontmatter needs both "name" and "description"`, {
      [path]: "missing name or description",
    });
  }
  const preset: NekAgentPreset = { name, description, instructions: body };
  if (typeof frontmatter.model === "string") preset.model = frontmatter.model;
  if (typeof frontmatter.thinking === "string") preset.thinking = frontmatter.thinking as NekAgentPreset["thinking"];
  if (typeof frontmatter.context_window === "number") preset.contextWindow = frontmatter.context_window;
  if (typeof frontmatter.readonly === "boolean") preset.readonly = frontmatter.readonly;
  const tools = readStringList(frontmatter.tools);
  if (tools) preset.tools = tools;
  const disallowedTools = readStringList(frontmatter.disallowed_tools);
  if (disallowedTools) preset.disallowedTools = disallowedTools;
  if (typeof frontmatter.is_background === "boolean") preset.isBackground = frontmatter.is_background;
  if (typeof frontmatter.autonomous === "boolean") preset.autonomous = frontmatter.autonomous;
  return preset;
}

export async function readAgentPresetFile(
  executor: NekConfigHostExecutor,
  path: string,
): Promise<NekAgentPresetFile | null> {
  const document = await readTextDocument(executor, path);
  if (document.content === null) return null;
  const parsed = parseFrontmatterDocument(path, document.content);
  return {
    path,
    revision: document.revision,
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    preset: frontmatterToPreset(path, parsed.frontmatter, parsed.body),
  };
}

/** 列出一个目录下的 `*.md`（目录不存在时为空）。 */
async function listPresetFiles(executor: NekConfigHostExecutor, dir: string): Promise<string[]> {
  const entries = await executor.listDir(dir);
  return entries
    .filter((entry) => !entry.isDirectory && entry.name.endsWith(".md"))
    .map((entry) => `${dir}/${entry.name}`);
}

export interface ListAgentPresetsArgs {
  executor: NekConfigHostExecutor;
  agentDir: string;
  cwd?: string;
  logger?: { warn: (...args: unknown[]) => void };
}

/**
 * 列出全部预设：内置 → 用户 → 项目（同名时后者覆盖前者，与 nek 的覆盖顺序一致）。
 *
 * 坏文件不打断列表，但要留下日志：契约里的条目没有诊断字段，静默丢弃会让"预设不见了"无从排查。
 */
export async function listAgentPresets(args: ListAgentPresetsArgs): Promise<NekAgentPresetEntry[]> {
  const { executor, agentDir, cwd, logger } = args;
  const entries: NekAgentPresetEntry[] = BUILTIN_PRESETS.map((preset) => ({
    revision: BUILTIN_PRESET_REVISION,
    source: "builtin",
    preset: { ...preset, tools: preset.tools ? [...preset.tools] : undefined },
  }));
  const scans: Array<{ dir: string; source: "user" | "project" }> = [
    { dir: agentsDir({ agentDir }, "global"), source: "user" },
  ];
  if (cwd) scans.push({ dir: agentsDir({ agentDir }, "project", cwd), source: "project" });
  const byKey = new Map<string, number>();
  for (const [index, entry] of entries.entries()) byKey.set(entry.preset.name, index);
  for (const scan of scans) {
    for (const path of await listPresetFiles(executor, scan.dir)) {
      let file: NekAgentPresetFile | null;
      try {
        file = await readAgentPresetFile(executor, path);
      } catch (error) {
        logger?.warn("skipping unreadable agent preset", path, error);
        continue;
      }
      if (!file) continue;
      const entry: NekAgentPresetEntry = {
        revision: file.revision,
        source: scan.source,
        path: file.path,
        preset: file.preset,
      };
      const existing = byKey.get(file.preset.name);
      if (existing === undefined) {
        byKey.set(file.preset.name, entries.length);
        entries.push(entry);
      } else {
        entries[existing] = entry;
      }
    }
  }
  return entries;
}

export interface WriteAgentPresetArgs {
  executor: NekConfigHostExecutor;
  agentDir: string;
  scope: NekConfigScope;
  preset: NekAgentPreset;
  expectedRevision: string;
  previousName?: string;
  cwd?: string;
}

export interface WriteAgentPresetResult {
  path: string;
  revision: string;
  /** 改名时被删除的旧路径（供 watch 通知）。 */
  removedPath?: string;
}

/**
 * 写预设：`<scope>/agents/<name>.md`。改名（`previousName`）时写完新文件再删旧文件，
 * 中途失败最多留下两份，不会丢配置。
 */
export async function writeAgentPreset(args: WriteAgentPresetArgs): Promise<WriteAgentPresetResult> {
  const { executor, agentDir, scope, preset, expectedRevision, previousName, cwd } = args;
  if (!PRESET_NAME_PATTERN.test(preset.name)) {
    throw validationError(`invalid preset name "${preset.name}"`, { name: "letters, digits, dot, dash, underscore" });
  }
  if (preset.description.trim() === "") {
    throw validationError("preset description must not be empty", { description: "required" });
  }
  const layout = { agentDir };
  const key = previousName ?? preset.name;
  const existingPath = agentPresetPath(layout, scope, key, cwd);
  const existing = await readAgentPresetFile(executor, existingPath);
  const previousRevision = existing?.revision ?? ABSENT_REVISION;
  if (!sameRevision(previousRevision, expectedRevision)) throw conflict(existingPath);
  const targetPath = agentPresetPath(layout, scope, preset.name, cwd);
  if (targetPath !== existingPath) {
    const target = await readAgentPresetFile(executor, targetPath);
    if (target) throw validationError(`preset "${preset.name}" already exists`, { name: "duplicate" });
  }
  // 未知 frontmatter 键原样保留：nek 会持续加字段，GUI 不认识不等于可以删。
  const preserved = existing
    ? Object.fromEntries(
        Object.entries(existing.frontmatter).filter(
          ([field]) => !(field in presetToFrontmatter(preset)),
        ),
      )
    : {};
  const frontmatter = { ...preserved, ...presetToFrontmatter(preset) };
  const content = serializeFrontmatterDocument(frontmatter, preset.instructions);
  const revision = await writeTextDocument(executor, targetPath, content);
  const removedPath = existingPath !== targetPath ? existingPath : undefined;
  if (removedPath) await executor.remove(removedPath);
  return { path: targetPath, revision, ...(removedPath ? { removedPath } : {}) };
}

export interface DeleteAgentPresetArgs {
  executor: NekConfigHostExecutor;
  agentDir: string;
  scope: NekConfigScope;
  name: string;
  expectedRevision: string;
  cwd?: string;
}

export async function deleteAgentPreset(args: DeleteAgentPresetArgs): Promise<{ path: string; revision: string }> {
  const path = agentPresetPath({ agentDir: args.agentDir }, args.scope, args.name, args.cwd);
  const existing = await readAgentPresetFile(args.executor, path);
  if (!existing) throw validationError(`preset "${args.name}" not found`, { name: "not found" });
  if (!sameRevision(existing.revision, args.expectedRevision)) throw conflict(path);
  if (existing.preset.readonly === true) {
    throw validationError(`preset "${args.name}" is read-only`, { name: "read-only" });
  }
  await args.executor.remove(path);
  return { path, revision: "absent" };
}

/** 供改名引用改写使用：列出所有带文件的预设（不含内置）。 */
export function isPresetFrontmatter(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}
