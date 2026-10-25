/**
 * mock：mcp.json（全局 + 项目覆盖）、导入预览、测试、运行状态与 OAuth。
 */
import type {
  NekConfigScope,
  NekMcpConfigView,
  NekMcpImportPreview,
  NekMcpServerConfig,
  NekMcpServerEntry,
  NekMcpServerStatus,
  NekMcpTestResult,
} from "@zcode/shared/nek-protocol";
import {
  assertRevision,
  clone,
  mockError,
  projectFile,
  type MockFile,
  type MockMachine,
} from "./mockMachine.js";
import type { Touch } from "./mockModels.js";

type ProjectMcp = Record<string, Partial<NekMcpServerConfig>>;

export function projectMcpFile(
  machine: MockMachine,
  cwd: string | undefined,
): MockFile<ProjectMcp> {
  return projectFile(
    machine.projectMcp,
    cwd,
    (dir) => `${dir}/.nek/mcp.json`,
    () => ({}),
  );
}

function isFullConfig(config: Partial<NekMcpServerConfig>): config is NekMcpServerConfig {
  return "command" in config || "url" in config;
}

export function readMcp(
  machine: MockMachine,
  scope: NekConfigScope,
  cwd?: string,
): NekMcpConfigView {
  if (scope === "global") {
    return {
      path: machine.mcp.path,
      revision: machine.mcp.revision,
      scope,
      servers: Object.entries(machine.mcp.value).map(([name, config]) => ({
        name,
        scope,
        config: clone(config),
        isOverride: false,
      })),
      diagnostics: [],
    };
  }
  const file = projectMcpFile(machine, cwd);
  const servers: NekMcpServerEntry[] = Object.entries(file.value).map(([name, config]) => {
    const base = machine.mcp.value[name];
    const merged = (isFullConfig(config) ? config : { ...base, ...config }) as NekMcpServerConfig;
    return { name, scope, config: clone(merged), isOverride: !isFullConfig(config) };
  });
  return { path: file.path, revision: file.revision, scope, servers, diagnostics: [] };
}

function fileFor(
  machine: MockMachine,
  scope: NekConfigScope,
  cwd?: string,
): MockFile<Record<string, unknown>> {
  return (scope === "global" ? machine.mcp : projectMcpFile(machine, cwd)) as MockFile<
    Record<string, unknown>
  >;
}

export function saveServer(
  machine: MockMachine,
  scope: NekConfigScope,
  entry: { name: string; config: NekMcpServerConfig; previousName?: string },
  options: { revision: string; cwd?: string },
  touch: Touch,
): string {
  const file = fileFor(machine, scope, options.cwd);
  assertRevision(file, options.revision);
  if (entry.name !== entry.previousName && entry.name in file.value) {
    throw mockError("validation", `MCP server ${entry.name} already exists`, { name: "duplicate" });
  }
  const next = { ...file.value };
  if (entry.previousName && entry.previousName !== entry.name) {
    delete next[entry.previousName];
  }
  next[entry.name] = clone(entry.config);
  file.value = next;
  return touch(file);
}

export function setOverride(
  machine: MockMachine,
  name: string,
  override: Partial<NekMcpServerConfig>,
  options: { revision: string; scope: NekConfigScope; cwd?: string },
  touch: Touch,
): string {
  const file = fileFor(machine, options.scope, options.cwd);
  assertRevision(file, options.revision);
  const current = (file.value[name] ?? {}) as Partial<NekMcpServerConfig>;
  file.value = { ...file.value, [name]: { ...current, ...clone(override) } };
  return touch(file);
}

export function deleteServer(
  machine: MockMachine,
  scope: NekConfigScope,
  name: string,
  options: { revision: string; cwd?: string },
  touch: Touch,
): string {
  const file = fileFor(machine, scope, options.cwd);
  assertRevision(file, options.revision);
  const next = { ...file.value };
  delete next[name];
  file.value = next;
  return touch(file);
}

function normalizeImported(raw: unknown): NekMcpServerConfig | string {
  if (typeof raw !== "object" || raw === null) {
    return "not an object";
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.url === "string") {
    const headers = value.headers as Record<string, string> | undefined;
    return { type: "http", url: value.url, ...(headers ? { headers } : {}) };
  }
  if (typeof value.command === "string") {
    return {
      command: value.command,
      ...(Array.isArray(value.args) ? { args: value.args.map(String) } : {}),
      ...(typeof value.env === "object" && value.env
        ? { env: value.env as Record<string, string> }
        : {}),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    };
  }
  return "missing command or url";
}

/** 兼容 Claude Desktop / Cursor 的 `{ mcpServers: {...} }`、裸对象 `{ name: config }` 与单个服务器。 */
export function previewImport(machine: MockMachine, json: string): NekMcpImportPreview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { servers: [], errors: [error instanceof Error ? error.message : String(error)] };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { servers: [], errors: ["Expected a JSON object"] };
  }
  const root = parsed as Record<string, unknown>;
  const map = (root.mcpServers ?? root.servers ?? root) as Record<string, unknown>;
  const entries =
    "command" in root || "url" in root ? [["server", root] as const] : Object.entries(map);
  const preview: NekMcpImportPreview = { servers: [], errors: [] };
  for (const [name, raw] of entries) {
    const config = normalizeImported(raw);
    if (typeof config === "string") {
      preview.errors.push(`${name}: ${config}`);
      continue;
    }
    preview.servers.push({ name, config, conflict: name in machine.mcp.value });
  }
  return preview;
}

const DEMO_TOOLS: Record<string, string[]> = {
  filesystem: ["read_file", "write_file", "list_directory", "search_files"],
  github: ["search_repositories", "get_issue", "create_pull_request"],
  sqlite: ["read_query", "write_query", "list_tables"],
};

function toolsOf(name: string): string[] {
  return DEMO_TOOLS[name] ?? ["ping", "echo"];
}

export function testServer(
  source: { name: string } | { config: NekMcpServerConfig },
): NekMcpTestResult {
  const name = "name" in source ? source.name : "";
  const command = "config" in source && "command" in source.config ? source.config.command : "";
  if (name === "broken" || command === "missing-binary") {
    return { ok: false, message: "spawn missing-binary ENOENT" };
  }
  return { ok: true, latencyMs: 420, tools: toolsOf(name).map((tool) => ({ name: tool })) };
}

export function mcpStatus(machine: MockMachine, cwd?: string): NekMcpServerStatus[] {
  const project = cwd ? (machine.projectMcp.get(cwd)?.value ?? {}) : {};
  return Object.entries(machine.mcp.value).map(([name, config]) =>
    statusOf(machine, name, { ...config, ...project[name] } as NekMcpServerConfig),
  );
}

export function statusOf(
  machine: MockMachine,
  name: string,
  config: NekMcpServerConfig,
): NekMcpServerStatus {
  const transport = "url" in config ? "http" : "stdio";
  const needsAuth = transport === "http" && "oauth" in config && config.oauth !== undefined;
  const loggedIn = machine.mcpAuth.get(name) === true;
  const enabled = config.enabled !== false;
  const exposure = config.exposure ?? "deferred";
  const base = { name, scope: "global" as const, transport, enabled, exposure } as const;
  if (!enabled) {
    return { ...base, state: "disabled", tools: [] };
  }
  if (name === "broken") {
    return { ...base, state: "failed", error: "spawn missing-binary ENOENT", tools: [] };
  }
  if (needsAuth && !loggedIn) {
    return { ...base, state: "needs_auth", tools: [], auth: { required: true, loggedIn: false } };
  }
  return {
    ...base,
    state: "connected",
    tools: toolsOf(name).map((tool) => ({
      name: tool,
      exposure: config.toolExposure?.[tool] ?? exposure,
    })),
    auth: needsAuth ? { required: true, loggedIn } : undefined,
  };
}
