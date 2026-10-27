/**
 * mock：settings.json、nek.yaml、子代理预设、AGENTS.md、资源清单、项目信任、复制到远程。
 */
import type {
  NekAgentPreset,
  NekAgentPresetEntry,
  NekAgentPresetsView,
  NekConfigScope,
  NekCopyItemResult,
  NekCopyPreview,
  NekCopyResolution,
  NekCopyResult,
  NekCopySelection,
  NekProjectTrust,
  NekSettingsPatch,
  NekSettingsReadResult,
  NekSettingsView,
  NekYamlPatch,
  NekYamlReadResult,
} from "@zcode/shared/nek-protocol";
import { mergeDeep } from "../../lib/settingsPatch.js";
import {
  assertRevision,
  clone,
  mockError,
  projectFile,
  type MockFile,
  type MockMachine,
  type MockYamlValues,
} from "./mockMachine.js";
import type { Touch } from "./mockModels.js";
import { MOCK_DEFAULT_SETTINGS, MOCK_YAML_DEFAULTS } from "./mockSeed.js";

type Plain = Record<string, unknown>;

function settingsFile(
  machine: MockMachine,
  scope: NekConfigScope,
  cwd?: string,
): MockFile<NekSettingsView> {
  if (scope === "global") {
    return machine.settings;
  }
  return projectFile(
    machine.projectSettings,
    cwd,
    (dir) => `${dir}/.nek/settings.json`,
    () => ({}),
  );
}

export function readSettings(
  machine: MockMachine,
  scope: NekConfigScope,
  cwd?: string,
): NekSettingsReadResult {
  const file = settingsFile(machine, scope, cwd);
  const project = cwd ? (machine.projectSettings.get(cwd)?.value ?? {}) : {};
  const effective = mergeDeep(
    mergeDeep(MOCK_DEFAULT_SETTINGS as Plain, machine.settings.value as Plain),
    (scope === "project" ? project : {}) as Plain,
  );
  return {
    path: file.path,
    revision: file.revision,
    scope,
    values: clone(file.value),
    effective: effective as NekSettingsView,
    defaults: clone(MOCK_DEFAULT_SETTINGS),
    diagnostics: [],
  };
}

export function patchSettings(
  machine: MockMachine,
  scope: NekConfigScope,
  patch: NekSettingsPatch,
  options: { revision: string; cwd?: string },
  touch: Touch,
): string {
  const file = settingsFile(machine, scope, options.cwd);
  assertRevision(file, options.revision);
  file.value = mergeDeep(file.value as Plain, patch as Plain) as NekSettingsView;
  return touch(file);
}

function yamlFile(
  machine: MockMachine,
  scope: NekConfigScope,
  cwd?: string,
): MockFile<MockYamlValues> {
  return scope === "global"
    ? machine.yaml
    : projectFile(
        machine.projectYaml,
        cwd,
        (dir) => `${dir}/.nek/nek.yaml`,
        () => ({}),
      );
}

export function readYaml(
  machine: MockMachine,
  scope: NekConfigScope,
  cwd?: string,
): NekYamlReadResult {
  const file = yamlFile(machine, scope, cwd);
  return {
    path: file.path,
    revision: file.revision,
    scope,
    values: clone(file.value),
    defaults: clone(MOCK_YAML_DEFAULTS),
    diagnostics: [],
  };
}

export function patchYaml(
  machine: MockMachine,
  scope: NekConfigScope,
  patch: NekYamlPatch,
  options: { revision: string; cwd?: string },
  touch: Touch,
): string {
  const file = yamlFile(machine, scope, options.cwd);
  assertRevision(file, options.revision);
  file.value = mergeDeep(file.value as Plain, patch as Plain) as MockYamlValues;
  return touch(file);
}

/** 预设列表 + 诊断 + 目录级组合 revision（与 nek 侧的 `NekAgentPresetsView` 同形）。 */
export function listPresets(machine: MockMachine, cwd?: string): NekAgentPresetsView {
  const entries = machine.presets
    .filter((entry) => entry.source !== "project" || (cwd && entry.path?.startsWith(cwd)))
    .map((entry) =>
      clone({
        source: entry.source,
        path: entry.path,
        revision: entry.revision,
        preset: entry.preset,
      }),
    );
  const diagnostics = machine.brokenPresets.filter(
    (item) => cwd !== undefined || !item.file.includes("/.nek/agents/"),
  );
  return {
    entries,
    diagnostics: clone(diagnostics),
    revision: entries
      .map((entry) => `${entry.path ?? entry.preset.name}:${entry.revision}`)
      .sort()
      .join("|"),
  };
}

function presetSource(scope: NekConfigScope): "user" | "project" {
  return scope === "project" ? "project" : "user";
}

export function savePreset(
  machine: MockMachine,
  scope: NekConfigScope,
  preset: NekAgentPreset,
  options: { revision: string; previousName?: string; cwd?: string },
  touch: Touch,
): string {
  const source = presetSource(scope);
  const key = options.previousName ?? preset.name;
  const existing = machine.presets.find(
    (entry) => entry.source === source && entry.preset.name === key,
  );
  if (existing && existing.revision !== options.revision) {
    throw mockError("conflict", `${existing.path} was modified externally`);
  }
  const clash = machine.presets.find(
    (entry) => entry.source === source && entry.preset.name === preset.name,
  );
  if (clash && clash !== existing) {
    throw mockError("validation", `Preset ${preset.name} already exists`, { name: "duplicate" });
  }
  const dir =
    scope === "project" ? `${options.cwd ?? ""}/.nek/agents` : `${machine.agentDir}/agents`;
  const file = {
    path: `${dir}/${preset.name}.md`,
    revision: existing?.revision ?? "absent",
    value: null,
  };
  const revision = touch(file);
  const entry = { source, path: file.path, revision, preset: clone(preset) } as const;
  machine.presets = existing
    ? machine.presets.map((item) => (item === existing ? { ...entry } : item))
    : [...machine.presets, { ...entry }];
  return revision;
}

export function deletePreset(
  machine: MockMachine,
  scope: NekConfigScope,
  name: string,
  options: { revision: string },
  touch: Touch,
): string {
  const source = presetSource(scope);
  const existing = machine.presets.find(
    (entry) => entry.source === source && entry.preset.name === name,
  );
  if (!existing?.path) {
    throw mockError("validation", `Preset ${name} not found`);
  }
  if (existing.revision !== options.revision) {
    throw mockError("conflict", `${existing.path} was modified externally`);
  }
  machine.presets = machine.presets.filter((entry) => entry !== existing);
  return touch({ path: existing.path, revision: existing.revision, value: null });
}

export function instructionsFile(
  machine: MockMachine,
  scope: NekConfigScope,
  cwd?: string,
): MockFile<string> {
  return scope === "global"
    ? machine.instructions
    : projectFile(
        machine.projectInstructions,
        cwd,
        (dir) => `${dir}/AGENTS.md`,
        () => "",
      );
}

export function resources(machine: MockMachine, cwd?: string) {
  const dir = machine.agentDir;
  return {
    skills: [
      { name: "pdf", path: `${dir}/skills/pdf/SKILL.md`, description: "Read and render PDF files" },
      { name: "release-notes", path: `${dir}/skills/release-notes/SKILL.md` },
    ],
    prompts: [
      { name: "review", path: `${dir}/prompts/review.md`, description: "Review staged changes" },
    ],
    extensions: [{ name: "llama", path: `${dir}/extensions/llama.ts` }],
    directories: { agentDir: dir, projectDir: cwd ? `${cwd}/.nek` : undefined },
  };
}

export function projectTrust(machine: MockMachine, cwd: string): NekProjectTrust {
  return {
    cwd,
    trusted: machine.trust.get(cwd) ?? null,
    defaultProjectTrust: machine.settings.value.defaultProjectTrust ?? "ask",
    resources: [
      { kind: "settings", path: `${cwd}/.nek/settings.json` },
      { kind: "mcp", path: `${cwd}/.nek/mcp.json` },
      { kind: "agents", path: `${cwd}/.nek/agents/docs-writer.md` },
      { kind: "system_prompt", path: `${cwd}/AGENTS.md` },
    ],
  };
}

function copyKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

export function previewCopy(
  from: MockMachine,
  to: MockMachine,
  selection: NekCopySelection,
): NekCopyPreview {
  const items: NekCopyPreview["items"] = [
    ...selection.providers.map((id) => ({
      kind: "provider" as const,
      id,
      conflict: to.models.value.some((provider) => provider.id === id),
    })),
    ...selection.logins.map((id) => ({
      kind: "login" as const,
      id,
      conflict: to.auth.get(id)?.kind === "oauth",
    })),
    ...selection.mcpServers.map((id) => ({
      kind: "mcpServer" as const,
      id,
      conflict: id in to.mcp.value,
    })),
  ];
  if (selection.defaults) {
    items.push({
      kind: "defaults",
      id: "defaults",
      conflict: Boolean(to.settings.value.defaultModel),
    });
  }
  if (selection.compaction) {
    items.push({
      kind: "compaction",
      id: "compaction",
      conflict: Boolean(to.settings.value.compaction),
    });
  }
  void from;
  return { items };
}

export function copy(
  from: MockMachine,
  to: MockMachine,
  selection: NekCopySelection,
  resolution: NekCopyResolution,
  touch: Touch,
): NekCopyResult {
  const preview = previewCopy(from, to, selection);
  const items: NekCopyItemResult[] = [];
  for (const item of preview.items) {
    const key = copyKey(item.kind, item.id);
    if (item.conflict && resolution[key] !== "overwrite") {
      items.push({ key, status: "skipped" });
      continue;
    }
    applyCopyItem(from, to, item.kind, item.id);
    items.push({ key, status: "copied" });
  }
  touch(to.models);
  touch(to.settings);
  touch(to.mcp);
  return { items };
}

function applyCopyItem(from: MockMachine, to: MockMachine, kind: string, id: string): void {
  if (kind === "provider") {
    const provider = from.models.value.find((item) => item.id === id);
    if (provider) {
      to.models.value = [...to.models.value.filter((item) => item.id !== id), clone(provider)];
    }
  } else if (kind === "login") {
    const status = from.auth.get(id);
    if (status) {
      to.auth.set(id, clone(status));
    }
  } else if (kind === "mcpServer") {
    const server = from.mcp.value[id];
    if (server) {
      to.mcp.value = { ...to.mcp.value, [id]: clone(server) };
    }
  } else if (kind === "defaults") {
    const { defaultProvider, defaultModel, defaultThinkingLevel, enabledModels } =
      from.settings.value;
    to.settings.value = {
      ...to.settings.value,
      defaultProvider,
      defaultModel,
      defaultThinkingLevel,
      enabledModels,
    };
  } else if (kind === "compaction") {
    to.settings.value = { ...to.settings.value, compaction: clone(from.settings.value.compaction) };
  }
}
