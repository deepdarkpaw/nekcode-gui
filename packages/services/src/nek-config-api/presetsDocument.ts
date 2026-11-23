/** nek v0.5.1: extensions/nek/services/agent-types.ts (scanAgentDir, discoverAgentTypes). */
import { createHash } from "node:crypto";
import {
  annotateAgentPresetOverrides,
  builtinAgentPresetEntries,
  effectiveAgentPresetTools,
  type NekAgentPreset,
  type NekAgentPresetsView,
  type NekConfigDiagnostic,
  type NekConfigScope,
} from "@zcode/shared/nek-protocol";
import {
  parseAgentMarkdown,
  serializeAgentMarkdown,
} from "../nek-agent/config/agentPresetFrontmatter.js";
import { writeTextDocument } from "./documents.js";
import { conflict, validationError } from "./errors.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import { agentPresetFileName, agentsDir, newAgentPresetPath, targetPaths } from "./paths.js";
import { ABSENT_REVISION, encodeRevision, sameRevision } from "./revision.js";

const MAX_PRESET_FILES = 512;
const MAX_PRESET_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/** Existing edits (including provider reference rewrites) carry a path-bound revision. */
export function presetFileRevision(path: string, revision: string): string {
  return `${path}\0${revision}`;
}

function presetFileRef(expectedRevision: string): { path: string; revision: string } {
  const parts = expectedRevision.split("\0", 3);
  const [path, revision] = parts;
  if (parts.length !== 2 || !path || !revision || revision === ABSENT_REVISION)
    throw validationError("Expected the revision of an existing preset file");
  return { path, revision };
}

async function readPresetText(executor: NekConfigHostExecutor, path: string) {
  const info = await executor.stat(path);
  if (!info) return null;
  if (info.isDirectory) throw new Error("EISDIR: cannot read a directory as a preset file");
  const content = await executor.readResourceFile(path, MAX_PRESET_BYTES);
  return { content, revision: encodeRevision(info, content) };
}

interface PresetsLocation {
  executor: NekConfigHostExecutor;
  agentDir: string;
  cwd?: string;
}

/** Scan direct `.md` entries in readdir order, including failures; never dedupe before annotating. */
export async function listAgentPresets({
  executor,
  agentDir,
  cwd,
  projectTrusted = true,
  logger,
}: PresetsLocation & {
  projectTrusted?: boolean;
  logger?: { warn: (...args: unknown[]) => void };
}): Promise<NekAgentPresetsView> {
  const entries = builtinAgentPresetEntries();
  const diagnostics: NekConfigDiagnostic[] = [];
  const revision = createHash("sha256").update(String(projectTrusted));
  const scopes = cwd ? (["global", "project"] as const) : (["global"] as const);
  let bytes = 0;
  const report = (path: string, error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    const message = detail.startsWith(`${path}:`) ? detail : `${path}: ${detail}`;
    diagnostics.push({ file: path, severity: "error", message });
    revision.update(JSON.stringify([path, message]));
    logger?.warn("skipping unreadable agent preset", path, error);
  };
  for (const scope of scopes) {
    const dir = agentsDir({ agentDir }, scope, cwd);
    let names: string[];
    try {
      names = (await executor.listDir(dir))
        .map((entry) => entry.name)
        .filter((name) => name.endsWith(".md"));
    } catch (error) {
      report(dir, error);
      continue;
    }
    if (names.length > MAX_PRESET_FILES)
      throw validationError(`Too many preset files in ${dir} (limit: ${MAX_PRESET_FILES})`);
    for (const name of names) {
      const path = targetPaths(dir).join(dir, name);
      try {
        const document = await readPresetText(executor, path);
        if (!document) throw new Error("ENOENT: preset file does not exist");
        bytes += Buffer.byteLength(document.content);
        revision.update(JSON.stringify([path, document.revision]));
        const { preset } = parseAgentMarkdown(path, document.content);
        entries.push({
          revision: presetFileRevision(path, document.revision),
          source: scope === "project" ? "project" : "user",
          path,
          preset,
          effectiveTools: effectiveAgentPresetTools(preset),
          ...(scope === "project" && !projectTrusted ? { untrusted: true } : {}),
        });
      } catch (error) {
        report(path, error);
      }
      if (bytes > MAX_SCAN_BYTES)
        throw validationError(`Preset scan exceeds ${MAX_SCAN_BYTES / (1024 * 1024)} MB: ${dir}`);
    }
  }
  return {
    entries: annotateAgentPresetOverrides(entries),
    diagnostics,
    revision: revision.digest("hex"),
  };
}

function filenameConflict(path: string) {
  return validationError(`preset file already exists: ${path}`, { name: "duplicate filename" });
}

function serializeCheckedPreset(
  path: string,
  preset: NekAgentPreset,
  existing?: ReturnType<typeof parseAgentMarkdown>,
): string {
  const content = serializeAgentMarkdown(path, preset, existing);
  if (Buffer.byteLength(content) > MAX_PRESET_BYTES)
    throw validationError(`Preset file exceeds ${MAX_PRESET_BYTES / 1024} KB: ${path}`);
  return content;
}

/** Create exclusively, even if a file (including invalid YAML or a link) appears after the check. */
async function createPresetFile(executor: NekConfigHostExecutor, path: string, content: string) {
  if ((await executor.resourceEntryKind(path)) !== null) throw filenameConflict(path);
  try {
    await executor.writeResourceFile(path, content, true);
  } catch (error) {
    if ((await executor.resourceEntryKind(path)) !== null) throw filenameConflict(path);
    throw error;
  }
  const info = await executor.stat(path);
  if (!info) throw conflict(path);
  return encodeRevision(info, content);
}

/** Rename the file only if its stem matched the old logical name. */
export async function writeAgentPreset({
  executor,
  agentDir,
  scope,
  preset,
  expectedRevision,
  cwd,
}: PresetsLocation & {
  scope: NekConfigScope;
  preset: NekAgentPreset;
  expectedRevision: string;
}): Promise<{ path: string; revision: string; removedPath?: string }> {
  const dir = agentsDir({ agentDir }, scope, cwd);
  const name = preset.name.trim();
  if (expectedRevision === ABSENT_REVISION) {
    const path = newAgentPresetPath(dir, name);
    const content = serializeCheckedPreset(path, { ...preset, name });
    return { path, revision: await createPresetFile(executor, path, content) };
  }
  const source = presetFileRef(expectedRevision);
  const filename = agentPresetFileName(dir, source.path);
  const document = await readPresetText(executor, source.path);
  if (!document || !sameRevision(document.revision, source.revision)) throw conflict(source.path);
  const existing = parseAgentMarkdown(source.path, document.content);
  const renameFile =
    filename.slice(0, -3) === existing.preset.name && name !== existing.preset.name;
  const path = renameFile ? newAgentPresetPath(dir, name) : source.path;
  const content = serializeCheckedPreset(path, { ...preset, name }, existing);
  if (!renameFile) return { path, revision: await writeTextDocument(executor, path, content) };
  const revision = await createPresetFile(executor, path, content);
  // Publish the new file before removing the source; a failed removal never loses the preset.
  await executor.remove(source.path);
  return { path, revision, removedPath: source.path };
}

export async function deleteAgentPreset({
  executor,
  agentDir,
  scope,
  path,
  expectedRevision,
  cwd,
}: PresetsLocation & {
  scope: NekConfigScope;
  path: string;
  expectedRevision: string;
}): Promise<{ path: string; revision: string }> {
  agentPresetFileName(agentsDir({ agentDir }, scope, cwd), path);
  const document = await readPresetText(executor, path);
  if (!document) throw validationError(`preset file not found: ${path}`);
  const expected = presetFileRef(expectedRevision);
  if (path !== expected.path || !sameRevision(document.revision, expected.revision))
    throw conflict(path);
  await executor.remove(path);
  return { path, revision: ABSENT_REVISION };
}
