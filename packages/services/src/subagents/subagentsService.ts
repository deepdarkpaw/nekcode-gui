/* eslint-disable max-lines */
import { access, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  createAgentStateId,
  modelSelectionSchema,
  type AgentCreateParams,
  type AgentDeleteParams,
  type AgentDiagnostic,
  type AgentScope,
  type AgentSummary,
  type AgentUpdateParams,
  type AgentsCapability,
  type AgentsListResult,
  type BuiltInSubagentModelOverrideParams,
  type BuiltInSubagentModelSelectionOverrides,
  type SubAgentConfig,
  type SubagentsListMode,
  type ZCodeProvider,
} from "@zcode/shared";
import { normalizeSubagentModelSelection } from "./subagentModelSelection.js";
import { serializeSubagentMarkdown, parseSubagentMarkdown } from "./subagentMarkdown.js";
import {
  resolveSubagentStateFile,
  resolveUserSubagentRoot,
  resolveWorkspaceSubagentRoot,
  type SubagentStorageOptions,
} from "./subagentStorage.js";
import type { ISubagentsService } from "./subagents.js";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";
import {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
  withFileLock,
} from "@zcode/shared/node";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

const subagentLogger = createServiceLogger("subagents");

interface AgentsStateFile {
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  disabledAgentIds: string[];
  // 仅供旧版本回滚保留；新版存在选择字段后，禁止再从这两个字段恢复覆盖。
  builtInModelOverrides?: unknown;
  builtInThoughtLevelOverrides?: unknown;
}

interface SubagentsServiceOptions extends SubagentStorageOptions {
  isDesktopRuntime?: boolean;
}

const BUILT_IN_AGENT_NAMES = new Set(["general-purpose", "Explore"]);

function createBuiltInAgents(
  modelSelectionOverrides: BuiltInSubagentModelSelectionOverrides = {},
): AgentSummary[] {
  const generalPurposeOverride = modelSelectionOverrides["general-purpose"];
  const exploreOverride = modelSelectionOverrides.Explore;
  return [
    {
      id: createAgentStateId({
        name: "general-purpose",
        scope: "built-in",
        source: "built-in",
      }),
      name: "general-purpose",
      description:
        "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
      // 内置子智能体使用显式身份色，避免 UI 按名称 hash 后把 general-purpose 显示为红色。
      color: "blue",
      injectAgentsMd: true,
      modelSelection: generalPurposeOverride,
      modelSelectionOverride: generalPurposeOverride,
      systemPrompt: "",
      tools: ["*"],
      path: "built-in:general-purpose",
      scope: "built-in",
      source: "built-in",
      enabled: true,
      readOnly: true,
    },
    {
      id: createAgentStateId({
        name: "Explore",
        scope: "built-in",
        source: "built-in",
      }),
      name: "Explore",
      description: "Read-only search agent for broad fan-out searches.",
      color: "cyan",
      injectAgentsMd: false,
      modelSelection: exploreOverride,
      modelSelectionOverride: exploreOverride,
      systemPrompt: "",
      tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
      path: "built-in:Explore",
      scope: "built-in",
      source: "built-in",
      enabled: true,
      readOnly: true,
    },
  ];
}

function emptyAgentsState(): AgentsStateFile {
  return {
    builtInModelSelectionOverrides: {},
    disabledAgentIds: [],
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeAgentsStateFile(parsed: unknown): AgentsStateFile {
  const record = (
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {}
  ) as {
    builtInModelSelectionOverrides?: unknown;
    builtInModelOverrides?: unknown;
    builtInThoughtLevelOverrides?: unknown;
    disabledAgentIds?: unknown;
  };
  const selections = normalizeBuiltInSelectionOverrides(record.builtInModelSelectionOverrides);
  return {
    ...record,
    builtInModelSelectionOverrides: selections,
    disabledAgentIds: Array.isArray(record.disabledAgentIds)
      ? record.disabledAgentIds.filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0,
        )
      : [],
  };
}

async function readAgentStateFileRaw(options?: SubagentsServiceOptions): Promise<AgentsStateFile> {
  try {
    const raw = await readFile(await resolveSubagentStateFile(options), "utf-8");
    return normalizeAgentsStateFile(JSON.parse(raw));
  } catch {
    return emptyAgentsState();
  }
}

async function readAgentStateFile(options?: SubagentsServiceOptions): Promise<AgentsStateFile> {
  await migrateSubagentStateFile(await resolveSubagentStateFile(options));
  return readAgentStateFileRaw(options);
}

/**
 * 在跨进程锁内完成 agents-state.json 的读-改-写。
 *
 * Bug 原因：该文件由 Host 与 CLI 共同写，CLI 的 migrateSubagentStateFile 已持锁而 Host 侧
 * 读写在锁外，后写方用旧快照整文件覆盖对方刚写入的覆盖项（跨进程丢更新）。
 * 修复依据：与 credentialService 相同，让跨进程锁覆盖读取、合并和原子替换的全过程。
 *
 * 迁移在锁外先行：migrateSubagentStateFile 自己会拿同一文件的锁，嵌套会导致同进程重入死等。
 */
async function updateAgentStateFile(
  update: (state: AgentsStateFile) => AgentsStateFile | Promise<AgentsStateFile>,
  options?: SubagentStorageOptions,
): Promise<AgentsStateFile> {
  const stateFile = await resolveSubagentStateFile(options);
  await migrateSubagentStateFile(stateFile);
  return withFileLock(stateFile, async () => {
    // 锁内只用不迁移的裸读：migrateSubagentStateFile 自己会拿同一文件的锁，嵌套会重入死等。
    const next = await update(await readAgentStateFileRaw(options));
    await mkdir(dirname(stateFile), { recursive: true });
    // 调用方已持跨进程锁，内层再加锁会自我等待到超时。
    await atomicWriteText(stateFile, JSON.stringify(next, null, 2), { useFileLock: false });
    return next;
  });
}

async function discoverFileAgents(params: {
  diagnostics: AgentDiagnostic[];
  includeUserAgents: boolean;
  includeWorkspaceAgents: boolean;
  storageOptions?: SubagentStorageOptions;
  workspacePath: string;
}): Promise<AgentSummary[]> {
  const roots: Array<{ scope: AgentScope; rootPath: string }> = [];
  if (params.includeUserAgents) {
    roots.push({
      scope: "user",
      rootPath: await resolveUserSubagentRoot(params.storageOptions),
    });
  }
  if (params.includeWorkspaceAgents) {
    roots.push({
      scope: "workspace",
      rootPath: resolveWorkspaceSubagentRoot(params.workspacePath),
    });
  }

  const agents: AgentSummary[] = [];
  for (const root of roots) {
    for (const agentPath of await collectAgentMarkdownPaths(root.rootPath)) {
      try {
        const markdown = await readFile(agentPath, "utf-8");
        const parsed = parseSubagentMarkdown({
          content: markdown,
          path: agentPath,
          scope: root.scope,
        });
        if (parsed.diagnostic) {
          params.diagnostics.push(parsed.diagnostic);
          continue;
        }
        if (parsed.agent) {
          agents.push({
            ...parsed.agent,
            projectPath: root.scope === "workspace" ? params.workspacePath : undefined,
          });
        }
      } catch {
        params.diagnostics.push({
          code: "agent_read_failed",
          message: `Failed to read agent Markdown: ${agentPath}`,
          path: agentPath,
        });
      }
    }
  }

  return agents;
}

async function collectAgentMarkdownPaths(rootPath: string): Promise<string[]> {
  if (!(await exists(rootPath))) {
    return [];
  }

  const rootStat = await lstat(rootPath).catch(() => undefined);
  if (!rootStat?.isDirectory()) {
    return [];
  }

  const result: string[] = [];
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectAgentMarkdownPaths(entryPath)));
      continue;
    }
    if (entry.isFile() && /\.(md|markdown)$/iu.test(entry.name)) {
      result.push(entryPath);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function resolveCapabilities(options?: SubagentsServiceOptions): AgentsCapability {
  const isDesktopRuntime = options?.isDesktopRuntime ?? Boolean(process.env.ZCODE_PROCESS_LABEL);
  if (isDesktopRuntime) {
    return { userScopeAvailable: true };
  }
  return { userScopeAvailable: false, userScopeReason: "desktop_only" };
}

function attachEnabledState(agents: AgentSummary[], state: AgentsStateFile): AgentSummary[] {
  const disabledSet = new Set(state.disabledAgentIds);
  return agents.map((agent) => ({
    ...agent,
    enabled: agent.scope === "user" ? !disabledSet.has(agent.id) : true,
  }));
}

function applyRuntimePrecedence(agents: AgentSummary[]): AgentSummary[] {
  const byName = new Map<string, AgentSummary>();
  for (const agent of agents) {
    byName.set(agent.name, agent);
  }
  return [...byName.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBuiltInSelectionOverrides(
  structured: unknown,
): BuiltInSubagentModelSelectionOverrides {
  const result: BuiltInSubagentModelSelectionOverrides = {};
  const structuredRecord = isRecord(structured) ? structured : {};
  const generalPurpose = modelSelectionSchema.safeParse(structuredRecord["general-purpose"]).data;
  const explore = modelSelectionSchema.safeParse(structuredRecord.Explore).data;
  if (generalPurpose) result["general-purpose"] = generalPurpose;
  if (explore) result.Explore = explore;
  return result;
}

export function createSubagentsService(options?: SubagentsServiceOptions): ISubagentsService & {
  /** Host 启动 Agent 前的一次性存储导入，不暴露为 Renderer RPC。 */
  prepareRuntimeState(): Promise<void>;
} {
  let writeQueue = Promise.resolve();
  const storageOptions: SubagentsServiceOptions = {
    homeDir: options?.homeDir,
  };

  return {
    async prepareRuntimeState() {
      const markdownMigration = await migrateUserSubagentMarkdown(
        await resolveUserSubagentRoot(storageOptions),
      );
      for (const failure of markdownMigration.failures)
        subagentLogger.warn(undefined, "用户 Subagent Markdown 迁移失败，保留原文件", failure);
      const runImport = async () =>
        migrateSubagentStateFile(await resolveSubagentStateFile(storageOptions));
      const queued = writeQueue.then(runImport, runImport);
      writeQueue = queued.catch(() => {});
      await queued;
    },

    async list(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
      mode?: SubagentsListMode;
    }): Promise<AgentsListResult> {
      const capability = resolveCapabilities(options);
      const mode = params.mode ?? "allRuntimeScopes";
      const diagnostics: AgentDiagnostic[] = [];
      if (capability.userScopeAvailable) {
        const migration = await migrateUserSubagentMarkdown(
          await resolveUserSubagentRoot(storageOptions),
        );
        for (const failure of migration.failures)
          diagnostics.push({
            code: "agent_read_failed",
            message: "Subagent Markdown migration failed; original file preserved",
            path: failure.path,
          });
      }
      const state = await readAgentStateFile(storageOptions);
      const builtInAgents = createBuiltInAgents(state.builtInModelSelectionOverrides);
      const fileAgents = await discoverFileAgents({
        diagnostics,
        includeUserAgents: capability.userScopeAvailable,
        includeWorkspaceAgents: mode === "allRuntimeScopes",
        storageOptions,
        workspacePath: params.workspacePath,
      });
      const sortedUserAgents = fileAgents
        .filter((agent) => agent.scope === "user")
        .sort((left, right) => left.name.localeCompare(right.name));
      const sortedWorkspaceAgents = fileAgents
        .filter((agent) => agent.scope === "workspace")
        .sort((left, right) => left.name.localeCompare(right.name));
      const discoveredAgents =
        mode === "settingsUserOnly"
          ? [...builtInAgents, ...sortedUserAgents]
          : applyRuntimePrecedence([
              ...builtInAgents,
              ...sortedUserAgents,
              ...sortedWorkspaceAgents,
            ]);
      const agents = attachEnabledState(discoveredAgents, state);

      return {
        agents,
        userAgents: agents.filter((agent) => agent.source === "user"),
        capability,
        diagnostics,
      };
    },

    async setEnabled(params: { agentId: string; enabled: boolean }): Promise<void> {
      const runUpdate = async (): Promise<void> => {
        await updateAgentStateFile((state) => {
          const previous = new Set(state.disabledAgentIds);
          if (params.enabled) {
            previous.delete(params.agentId);
          } else {
            previous.add(params.agentId);
          }
          state.disabledAgentIds = [...previous].sort();
          return state;
        }, storageOptions);
      };

      const queued = writeQueue.then(runUpdate, runUpdate);
      writeQueue = queued.catch(() => {});
      await queued;
    },

    async setBuiltInModelOverride(params: BuiltInSubagentModelOverrideParams): Promise<void> {
      const runUpdate = async (): Promise<void> => {
        await updateAgentStateFile((state) => {
          const builtInModelSelectionOverrides = {
            ...state.builtInModelSelectionOverrides,
          };
          const modelSelection = normalizeSubagentModelSelection(params.modelSelection);
          if (modelSelection) {
            builtInModelSelectionOverrides[params.agentName] = modelSelection;
          } else {
            delete builtInModelSelectionOverrides[params.agentName];
          }
          return { ...state, builtInModelSelectionOverrides };
        }, storageOptions);
      };

      const queued = writeQueue.then(runUpdate, runUpdate);
      writeQueue = queued.catch(() => {});
      await queued;
    },

    async getPrimaryUserAgentsDirectory(_params: { provider: ZCodeProvider }): Promise<{
      path: string;
    }> {
      const path = await resolveUserSubagentRoot(storageOptions);
      await mkdir(path, { recursive: true });
      return { path };
    },

    async createAgent(params: AgentCreateParams): Promise<{ agent: AgentSummary }> {
      validateUserAgentConfig(params.config);
      assertNotBuiltInName(params.config.name);

      const scope = params.scope ?? "user";
      const agentDir =
        scope === "workspace"
          ? resolveWorkspaceSubagentRoot(requireWorkspacePath(params.workspacePath))
          : await resolveUserSubagentRoot(storageOptions);
      const filePath = join(agentDir, `${params.config.name.trim().toLowerCase()}.md`);
      await mkdir(agentDir, { recursive: true });
      if (await exists(filePath)) {
        throw new Error(`Agent file "${basename(filePath)}" already exists`);
      }

      const content = serializeSubagentMarkdown(normalizeConfig(params.config));
      const agent = parseSavedAgent(content, filePath, scope, params.workspacePath);
      // 先验证即将写入的 Markdown 可解析，避免 serializer 回归时把坏 profile 落盘。
      await writeFile(filePath, content, { encoding: "utf-8", flag: "wx" });
      return { agent };
    },

    async updateAgent(params: AgentUpdateParams): Promise<{ agent: AgentSummary }> {
      validateUserAgentConfig(params.config);
      assertNotBuiltInName(params.config.name);

      const scope = params.scope ?? "user";
      const agentDir =
        scope === "workspace"
          ? resolveWorkspaceSubagentRoot(requireWorkspacePath(params.workspacePath))
          : await resolveUserSubagentRoot(storageOptions);
      const filePath = join(agentDir, `${params.config.name.trim().toLowerCase()}.md`);
      await mkdir(agentDir, { recursive: true });

      if (params.oldFilePath && params.oldFilePath !== filePath && (await exists(filePath))) {
        throw new Error(`Agent file "${basename(filePath)}" already exists`);
      }

      const content = serializeSubagentMarkdown(normalizeConfig(params.config));
      const agent = parseSavedAgent(content, filePath, scope, params.workspacePath);
      // 更新时同样先 parse 再覆盖旧文件，避免失败保存破坏已有用户 agent。
      await writeFile(filePath, content, "utf-8");
      // enabled 状态按 agent id 存储；重命名会生成新 id，必须迁移旧禁用记录，
      // 否则用户禁用的 agent 改名后会被 runtime 当成新启用 profile 重新加载。
      await migrateDisabledAgentId(params.agentId, agent.id, storageOptions);
      if (params.oldFilePath && params.oldFilePath !== filePath) {
        await rm(params.oldFilePath, { force: true });
      }
      return { agent };
    },

    async deleteAgent(params: AgentDeleteParams): Promise<void> {
      await rm(params.filePath, { force: true });

      await updateAgentStateFile((state) => {
        const disabledSet = new Set(state.disabledAgentIds);
        disabledSet.delete(params.agentId);
        state.disabledAgentIds = [...disabledSet].sort();
        return state;
      }, storageOptions);
    },
  };
}

function validateUserAgentConfig(config: SubAgentConfig): void {
  const trimmedName = config.name.trim();
  const nameRegex = /^[a-zA-Z0-9-]+$/;
  const minNameLength = 3;
  const maxNameLength = 50;
  if (trimmedName.length < minNameLength || trimmedName.length > maxNameLength) {
    throw new Error(`Name must be between ${minNameLength} and ${maxNameLength} characters`);
  }
  if (!nameRegex.test(trimmedName)) {
    throw new Error("Name can only contain letters, numbers, and hyphens");
  }
  if (config.description.trim().length === 0) {
    throw new Error("Description is required");
  }
  if (config.systemPrompt.trim().length === 0) {
    throw new Error("System prompt is required");
  }
}

function assertNotBuiltInName(name: string): void {
  if (BUILT_IN_AGENT_NAMES.has(name.trim())) {
    throw new Error(`Agent name "${name.trim()}" is reserved by a built-in agent`);
  }
}

async function migrateDisabledAgentId(
  previousAgentId: string,
  nextAgentId: string,
  options?: SubagentStorageOptions,
): Promise<void> {
  if (previousAgentId === nextAgentId) {
    return;
  }
  await updateAgentStateFile((state) => {
    const disabledSet = new Set(state.disabledAgentIds);
    if (!disabledSet.has(previousAgentId)) {
      return state;
    }
    disabledSet.delete(previousAgentId);
    disabledSet.add(nextAgentId);
    return { ...state, disabledAgentIds: [...disabledSet].sort() };
  }, options);
}

function normalizeConfig(config: SubAgentConfig): SubAgentConfig {
  return {
    ...config,
    name: config.name.trim(),
    description: config.description.trim(),
    systemPrompt: config.systemPrompt.trim(),
    modelSelection: normalizeSubagentModelSelection(config.modelSelection),
  };
}

function requireWorkspacePath(workspacePath: string | undefined): string {
  const value = workspacePath?.trim();
  if (!value) throw new Error("Workspace path is required for workspace subagents");
  return value;
}

function parseSavedAgent(
  content: string,
  path: string,
  scope: "user" | "workspace",
  workspacePath?: string,
): AgentSummary {
  const parsed = parseSubagentMarkdown({
    content,
    path,
    scope,
  });
  if (parsed.diagnostic || !parsed.agent) {
    throw new Error(parsed.diagnostic?.message ?? `Failed to parse saved agent: ${path}`);
  }
  return {
    ...parsed.agent,
    projectPath: scope === "workspace" ? workspacePath : undefined,
  };
}
