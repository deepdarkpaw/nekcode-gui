/**
 * mcp.json：全局与项目两份，项目条目可以只覆盖 `enabled` / `exposure` / `toolExposure`。
 *
 * 语义与 nek `extensions/mcp/config.ts` 一致：
 * - 项目条目没有 `command` / `url` / `type` 时视为"覆盖"，其余字段沿用全局条目
 *   （项目文件因此拿不到凭据，也不会因为拷贝一份就把密钥写进仓库）；
 * - 项目条目里除这三个键以外的字段是错误，不是"忽略"。
 */
import type {
  NekConfigDiagnostic,
  NekConfigRevision,
  NekConfigScope,
  NekConfigTarget,
  NekMcpConfigView,
  NekMcpImportPreview,
  NekMcpServerConfig,
  NekMcpServerEntry,
  NekMcpServerStatus,
  NekMcpTestResult,
} from "@zcode/shared/nek-protocol";
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";
import {
  NEK_MCP_SERVER_NAME_PATTERN,
  nekMcpHttpServerSchema,
  nekMcpOverrideSchema,
  nekMcpStdioServerSchema,
  parseWithSchema,
} from "../nek-agent/config/schemas.js";
import { writeTextDocument } from "./documents.js";
import { conflict, fieldErrorsOf, validationError } from "./errors.js";
import {
  isFullServer,
  MCP_OVERRIDE_KEYS,
  overrideKeysOf,
  readMcpServerFile,
  serializeMcpServers,
} from "./mcpDocument.js";
import type { RawMcpServers } from "./mcpDocument.js";
import { mcpPath } from "./paths.js";
import type { NekConfigRuntime, NekConfigSessionHandle } from "./runtime.js";

export interface NekMcpGroup {
  readMcpConfig: (
    target: NekConfigTarget,
    scope: NekConfigScope,
    cwd?: string,
  ) => Promise<NekMcpConfigView>;
  saveMcpServer: (
    target: NekConfigTarget,
    scope: NekConfigScope,
    entry: { name: string; config: NekMcpServerConfig; previousName?: string },
    options: { revision: string; cwd?: string },
  ) => Promise<NekConfigRevision>;
  setMcpServerOverride: (
    target: NekConfigTarget,
    name: string,
    override: {
      enabled?: boolean;
      exposure?: NekMcpServerConfig["exposure"];
      toolExposure?: Record<string, NonNullable<NekMcpServerConfig["exposure"]>>;
    },
    options: { revision: string; scope: NekConfigScope; cwd?: string },
  ) => Promise<NekConfigRevision>;
  deleteMcpServer: (
    target: NekConfigTarget,
    scope: NekConfigScope,
    name: string,
    options: { revision: string; cwd?: string },
  ) => Promise<NekConfigRevision>;
  previewMcpImport: (
    target: NekConfigTarget,
    scope: NekConfigScope,
    json: string,
    cwd?: string,
  ) => Promise<NekMcpImportPreview>;
  testMcpServer: (
    target: NekConfigTarget,
    source: { name: string; cwd?: string } | { config: NekMcpServerConfig },
  ) => Promise<NekMcpTestResult>;
  getMcpStatus: (
    target: NekConfigTarget,
    cwd?: string,
  ) => Promise<NekMcpServerStatus[] | undefined>;
  mcpServerAction: (
    target: NekConfigTarget,
    name: string,
    action: "reconnect" | "login" | "logout",
    cwd?: string,
  ) => Promise<NekMcpServerStatus>;
}

const NAME_FIELD = { name: "letters, digits, underscore and dash" } as const;

/** 按 transport 选 schema 并校验；失败抛字段级错误。 */
function validateServerConfig(name: string, config: Record<string, unknown>): NekMcpServerConfig {
  const validated =
    config.url !== undefined
      ? parseWithSchema(nekMcpHttpServerSchema, config)
      : parseWithSchema(nekMcpStdioServerSchema, config);
  if (!validated.ok) {
    throw validationError(`invalid MCP server "${name}"`, fieldErrorsOf(validated.issues));
  }
  return validated.data as unknown as NekMcpServerConfig;
}

export function createMcpGroup(runtime: NekConfigRuntime): NekMcpGroup {
  const paths = (target: NekConfigTarget, scope: NekConfigScope, cwd?: string) => {
    const context = runtime.target(target);
    runtime.rememberCwd(target, cwd);
    return { context, path: mcpPath(context.layout, scope, cwd) };
  };

  const sessionFor = (
    target: NekConfigTarget,
    cwd?: string,
  ): NekConfigSessionHandle | undefined => {
    const sessions = runtime.sessionsOf(target);
    if (sessions.length === 0) return undefined;
    if (cwd) {
      const exact = sessions.find((session) => session.cwd === cwd);
      if (exact) return exact;
    }
    return sessions[0];
  };

  return {
    readMcpConfig: async (target, scope, cwd) => {
      const { context, path } = paths(target, scope, cwd);
      const own = await readMcpServerFile(context.executor, path);
      const diagnostics: NekConfigDiagnostic[] = [];
      if (scope === "global") {
        return {
          path,
          revision: own.revision,
          scope,
          servers: Object.entries(own.servers).map<NekMcpServerEntry>(([name, config]) => ({
            name,
            scope,
            config: config as NekMcpServerConfig,
            isOverride: false,
          })),
          diagnostics,
        };
      }
      const globalPath = mcpPath(context.layout, "global");
      const global = await readMcpServerFile(context.executor, globalPath).catch(
        (error: unknown): { revision: string; servers: RawMcpServers } => {
          diagnostics.push({
            file: globalPath,
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          return { revision: "absent", servers: {} };
        },
      );
      const servers: NekMcpServerEntry[] = [];
      for (const [name, config] of Object.entries(own.servers)) {
        if (isFullServer(config)) {
          servers.push({ name, scope, config: config as NekMcpServerConfig, isOverride: false });
          continue;
        }
        const extra = overrideKeysOf(config);
        const base = global.servers[name];
        if (extra.length > 0) {
          diagnostics.push({
            file: path,
            severity: "error",
            message: `server "${name}": an override can only set ${MCP_OVERRIDE_KEYS.join(", ")}`,
          });
        }
        if (!base) {
          diagnostics.push({
            file: path,
            severity: "error",
            message: `server "${name}" needs "command" or "url", or a global server to override`,
          });
          continue;
        }
        servers.push({
          name,
          scope,
          config: { ...base, ...config } as NekMcpServerConfig,
          isOverride: true,
        });
      }
      return { path, revision: own.revision, scope, servers, diagnostics };
    },

    saveMcpServer: async (target, scope, entry, options) => {
      if (!NEK_MCP_SERVER_NAME_PATTERN.test(entry.name)) {
        throw validationError(`invalid MCP server name "${entry.name}"`, { name: NAME_FIELD.name });
      }
      const config = entry.config as unknown as Record<string, unknown>;
      if (scope === "project") {
        const extra = overrideKeysOf(config);
        if (extra.length > 0) {
          throw validationError(`project mcp.json can only set ${MCP_OVERRIDE_KEYS.join(", ")}`, {
            config: `unexpected keys: ${extra.join(", ")}`,
          });
        }
      }
      const value =
        scope === "project"
          ? validateOverrideConfig(entry.name, config)
          : validateServerConfig(entry.name, config);
      const { context, path } = paths(target, scope, options.cwd);
      const current = await readMcpServerFile(context.executor, path);
      if (current.revision !== options.revision) throw conflict(path);
      const previousName = entry.previousName;
      if (entry.name !== previousName && current.servers[entry.name]) {
        throw validationError(`MCP server "${entry.name}" already exists`, { name: "duplicate" });
      }
      const servers: RawMcpServers = { ...current.servers };
      if (previousName && previousName !== entry.name) delete servers[previousName];
      servers[entry.name] = value as unknown as Record<string, unknown>;
      const revision = await writeTextDocument(
        context.executor,
        path,
        serializeMcpServers(servers),
      );
      runtime.publishWrite(target, [{ path, revision }]);
      return { revision };
    },

    setMcpServerOverride: async (target, name, override, options) => {
      const { context, path } = paths(target, options.scope, options.cwd);
      const current = await readMcpServerFile(context.executor, path);
      if (current.revision !== options.revision) throw conflict(path);
      if (options.scope === "global") {
        if (!current.servers[name]) {
          throw validationError(`unknown MCP server "${name}"`, { name: "unknown" });
        }
      } else {
        const globalPath = mcpPath(context.layout, "global");
        const global = await readMcpServerFile(context.executor, globalPath);
        if (!global.servers[name]) {
          throw validationError(
            `server "${name}" is not defined globally; a project entry can only override it`,
            { name: "missing global server" },
          );
        }
      }
      const merged = { ...current.servers[name], ...(override as Record<string, unknown>) };
      const servers: RawMcpServers = { ...current.servers, [name]: merged };
      const revision = await writeTextDocument(
        context.executor,
        path,
        serializeMcpServers(servers),
      );
      runtime.publishWrite(target, [{ path, revision }]);
      return { revision };
    },

    deleteMcpServer: async (target, scope, name, options) => {
      const { context, path } = paths(target, scope, options.cwd);
      const current = await readMcpServerFile(context.executor, path);
      if (current.revision !== options.revision) throw conflict(path);
      if (!current.servers[name]) {
        throw validationError(`unknown MCP server "${name}"`, { name: "unknown" });
      }
      const servers: RawMcpServers = { ...current.servers };
      delete servers[name];
      const revision = await writeTextDocument(
        context.executor,
        path,
        serializeMcpServers(servers),
      );
      runtime.publishWrite(target, [{ path, revision }]);
      return { revision };
    },

    previewMcpImport: async (target, scope, json, cwd) => {
      const { context, path } = paths(target, scope, cwd);
      const existing = await readMcpServerFile(context.executor, path);
      const preview: NekMcpImportPreview = { servers: [], errors: [] };
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (error) {
        return {
          servers: [],
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
      if (!isPlainObject(parsed)) return { servers: [], errors: ["expected a JSON object"] };
      const root = parsed;
      const single = root.command !== undefined || root.url !== undefined;
      const map = isPlainObject(root.mcpServers)
        ? root.mcpServers
        : isPlainObject(root.servers)
          ? root.servers
          : root;
      const entries: Array<[string, unknown]> = single
        ? [["server", root]]
        : Object.entries(map as Record<string, unknown>);
      for (const [name, raw] of entries) {
        if (!isPlainObject(raw)) {
          preview.errors.push(`${name}: not an object`);
          continue;
        }
        if (!NEK_MCP_SERVER_NAME_PATTERN.test(name)) {
          preview.errors.push(`${name}: invalid server name`);
          continue;
        }
        const normalized: Record<string, unknown> = { ...raw };
        if (normalized.url !== undefined && normalized.type === undefined) normalized.type = "http";
        try {
          preview.servers.push({
            name,
            config: validateServerConfig(name, normalized),
            conflict: existing.servers[name] !== undefined,
          });
        } catch (error) {
          preview.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      return preview;
    },

    testMcpServer: async (target, source) => {
      const control = await runtime.control(target);
      const command =
        "config" in source
          ? { type: "mcp_test" as const, config: source.config }
          : { type: "mcp_test" as const, name: source.name, cwd: source.cwd };
      return await control.call(command);
    },

    getMcpStatus: async (target, cwd) => {
      const session = sessionFor(target, cwd);
      if (!session) return undefined;
      const data = await session.call({ type: "extension_call", method: "mcp.status" });
      const result = data.result as { servers?: NekMcpServerStatus[] } | undefined;
      return result?.servers ?? [];
    },

    mcpServerAction: async (target, name, action, cwd) => {
      const session = sessionFor(target, cwd);
      if (!session) {
        throw validationError(
          "no nek session is running for this target; open a session to control MCP servers",
          { session: "none running" },
        );
      }
      const method = `mcp.${action}`;
      const data = await session.call({ type: "extension_call", method, params: { name } });
      const result = data.result as { server?: NekMcpServerStatus } | undefined;
      if (!result?.server) {
        throw validationError(`nek returned no status for MCP server "${name}"`, {
          name: "no status",
        });
      }
      return result.server;
    },
  };
}

/** 项目级条目只能是覆盖（`enabled` / `exposure` / `toolExposure`）。 */
function validateOverrideConfig(name: string, config: Record<string, unknown>): NekMcpServerConfig {
  const validated = parseWithSchema(nekMcpOverrideSchema, config);
  if (!validated.ok) {
    throw validationError(`invalid MCP override "${name}"`, fieldErrorsOf(validated.issues));
  }
  return validated.data as unknown as NekMcpServerConfig;
}
