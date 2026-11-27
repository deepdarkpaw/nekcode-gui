/** Read raw MCP configs and validate drafts before writing on the target host. */
import {
  isNekMcpOverride,
  validateNekMcpOverride,
  validateNekMcpServer,
  type INekConfigApi,
  type NekConfigScope,
  type NekConfigTarget,
  type NekMcpImportPreview,
  type NekMcpServerConfig,
  type NekMcpServerEntry,
  type NekMcpServerStatus,
} from "@zcode/shared/nek-protocol";
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";
import { writeTextDocument } from "./documents.js";
import { conflict, validationError } from "./errors.js";
import { readMcpServerFile, serializeMcpServers } from "./mcpDocument.js";
import { mcpPath } from "./paths.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import type { NekConfigRuntime, NekConfigSessionHandle } from "./runtime.js";

export type NekMcpGroup = Pick<
  INekConfigApi,
  | "readMcpConfig"
  | "saveMcpServer"
  | "setMcpServerOverride"
  | "deleteMcpServer"
  | "previewMcpImport"
  | "testMcpServer"
  | "getMcpStatus"
  | "mcpServerAction"
>;

type McpIssues = Extract<ReturnType<typeof validateNekMcpServer>, { ok: false }>;

function checked<T>(name: string, result: McpIssues | { ok: true; config: T }): T {
  if (result.ok) return result.config;
  const messages = result.issues.map(({ field, message }) =>
    field === "name" ? message : `server ${JSON.stringify(name)}: ${message}`,
  );
  const fields = Object.fromEntries(
    result.issues.map(({ field, message }) => [
      field,
      field === "name" ? 'use letters, digits, "_" and "-"' : message,
    ]),
  );
  throw validationError(messages.join("; "), fields);
}

function serverAt(
  servers: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(servers, name)) return undefined;
  const server = servers[name];
  return isPlainObject(server) ? server : undefined;
}

/** Project writes never materialize the global transport or credentials. */
function validateWrite(
  name: string,
  raw: unknown,
  scope: NekConfigScope,
  globals?: Record<string, unknown>,
) {
  if (scope === "global") return checked(name, validateNekMcpServer(name, raw));
  const override = checked(name, validateNekMcpOverride(name, raw));
  const base = globals && serverAt(globals, name);
  if (!base) {
    throw validationError(`server ${JSON.stringify(name)} needs a global server to override`, {
      name: "missing global server",
    });
  }
  checked(name, validateNekMcpServer(name, { ...base, ...override }));
  return override;
}

function configFileKey(path: string) {
  return /^[a-z]:|^\\/i.test(path) ? path.replaceAll("\\", "/").toLowerCase() : path;
}

export function createMcpGroup(runtime: NekConfigRuntime): NekMcpGroup {
  const paths = (target: NekConfigTarget, scope: NekConfigScope, cwd?: string) => {
    const context = runtime.target(target);
    return { context, path: mcpPath(context.layout, scope, cwd) };
  };

  const sessionFor = (
    target: NekConfigTarget,
    cwd?: string,
  ): NekConfigSessionHandle | undefined => {
    const sessions = runtime.sessionsOf(target);
    return (cwd ? sessions.find((session) => session.cwd === cwd) : undefined) ?? sessions[0];
  };

  const write = async (
    target: NekConfigTarget,
    executor: NekConfigHostExecutor,
    path: string,
    document: Awaited<ReturnType<typeof readMcpServerFile>>,
    servers: Record<string, unknown>,
  ) => {
    const revision = await writeTextDocument(
      executor,
      path,
      serializeMcpServers(servers, document.root),
    );
    await runtime.publishWrite(target, [{ path, revision }]);
    return { revision };
  };

  return {
    readMcpConfig: async (target, scope, cwd) => {
      const { context, path } = paths(target, scope, cwd);
      const own = await readMcpServerFile(context.executor, path);
      const globalPath = mcpPath(context.layout, "global");
      const control = await runtime.control(target);
      const validation = await control.call(
        scope === "project" && cwd ? { type: "validate_config", cwd } : { type: "validate_config" },
      );
      const diagnostics = validation.diagnostics.filter(
        ({ file }) => configFileKey(file) === configFileKey(path),
      );
      const global =
        scope === "project" ? await readMcpServerFile(context.executor, globalPath) : undefined;
      const servers: NekMcpServerEntry[] = [];
      for (const [name, raw] of Object.entries(own.servers)) {
        if (!isPlainObject(raw)) continue;
        const isOverride = scope === "project" && isNekMcpOverride(raw);
        const base = isOverride && global ? serverAt(global.servers, name) : undefined;
        if (isOverride && !base) continue;
        servers.push({
          name,
          scope,
          path,
          isOverride,
          config: (isOverride ? { ...base, ...raw } : raw) as NekMcpServerConfig,
          ...(isOverride ? { override: raw } : {}),
        });
      }
      return { path, revision: own.revision, scope, servers, diagnostics };
    },

    saveMcpServer: async (target, scope, entry, options) => {
      const { context, path } = paths(target, scope, options.cwd);
      const current = await readMcpServerFile(context.executor, path);
      if (current.revision !== options.revision) throw conflict(path);
      const global =
        scope === "project"
          ? await readMcpServerFile(context.executor, mcpPath(context.layout, "global"))
          : undefined;
      const value = validateWrite(entry.name, entry.config, scope, global?.servers);
      const { previousName } = entry;
      if (entry.name !== previousName && Object.hasOwn(current.servers, entry.name)) {
        throw validationError(`MCP server "${entry.name}" already exists`, { name: "duplicate" });
      }
      const servers = { ...current.servers, [entry.name]: value };
      if (previousName !== undefined && previousName !== entry.name) delete servers[previousName];
      return await write(target, context.executor, path, current, servers);
    },

    setMcpServerOverride: async (target, name, override, options) => {
      const patch = checked(name, validateNekMcpOverride(name, override));
      const { scope, cwd } = options;
      const { context, path } = paths(target, scope, cwd);
      const current = await readMcpServerFile(context.executor, path);
      if (current.revision !== options.revision) throw conflict(path);
      const own = serverAt(current.servers, name);
      if (!own && (scope === "global" || Object.hasOwn(current.servers, name))) {
        throw validationError(`No MCP definition for ${JSON.stringify(name)} to edit`, {
          name: "unknown",
        });
      }
      const global =
        scope === "project"
          ? await readMcpServerFile(context.executor, mcpPath(context.layout, "global"))
          : undefined;
      const value = validateWrite(name, { ...own, ...patch }, scope, global?.servers);
      return await write(target, context.executor, path, current, {
        ...current.servers,
        [name]: value,
      });
    },

    deleteMcpServer: async (target, scope, name, options) => {
      const { context, path } = paths(target, scope, options.cwd);
      const current = await readMcpServerFile(context.executor, path);
      if (current.revision !== options.revision) throw conflict(path);
      if (!Object.hasOwn(current.servers, name)) {
        throw validationError(`unknown MCP server "${name}"`, { name: "unknown" });
      }
      const servers = { ...current.servers };
      delete servers[name];
      return await write(target, context.executor, path, current, servers);
    },

    previewMcpImport: async (target, scope, json, cwd) => {
      const { context, path } = paths(target, scope, cwd);
      const existing = await readMcpServerFile(context.executor, path);
      const global =
        scope === "project"
          ? await readMcpServerFile(context.executor, mcpPath(context.layout, "global"))
          : undefined;
      const preview: NekMcpImportPreview = { servers: [], errors: [] };
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (error) {
        return { servers: [], errors: [error instanceof Error ? error.message : String(error)] };
      }
      if (!isPlainObject(parsed)) return { servers: [], errors: ["expected a JSON object"] };
      const map = parsed.mcpServers === undefined ? parsed.servers : parsed.mcpServers;
      if (map !== undefined && !isPlainObject(map)) {
        return { servers: [], errors: ['expected an object with an "mcpServers" object'] };
      }
      const single = [parsed.command, parsed.url, parsed.type].some(
        (value) => value !== undefined && !isPlainObject(value),
      );
      const entries: Array<[string, unknown]> =
        map !== undefined
          ? Object.entries(map)
          : single
            ? [["server", parsed]]
            : Object.entries(parsed);
      for (const [name, raw] of entries) {
        try {
          preview.servers.push({
            name,
            config: validateWrite(name, raw, scope, global?.servers),
            conflict: Object.hasOwn(existing.servers, name),
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
