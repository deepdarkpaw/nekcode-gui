/**
 * mcp.json 与子代理预设（agents/*.md）的文档 hooks。
 */
import { useCallback, useMemo } from "react";
import type {
  NekAgentPreset,
  NekAgentPresetsView,
  NekConfigScope,
  NekMcpConfigView,
  NekMcpServerConfig,
  NekMcpServerEntry,
  NekMcpServerOverride,
} from "@zcode/shared/nek-protocol";
import { useNekSettingsContext } from "./NekSettingsContext.js";
import { NekConfigApiError } from "./nekErrors.js";
import { normalizeConfigPath, useNekDocument, type NekDocument } from "./useNekDocument.js";

type McpWrite = {
  name: string;
  config: NekMcpServerConfig | NekMcpServerOverride;
  previousName?: string;
};

export interface NekMcpDocument extends NekDocument<NekMcpConfigView> {
  scope: NekConfigScope;
  saveServer: (entry: McpWrite) => Promise<void>;
  deleteServer: (name: string) => Promise<void>;
  setOverride: (name: string, override: NekMcpServerOverride) => Promise<void>;
}

function upsertServer(
  servers: readonly NekMcpServerEntry[],
  entry: NekMcpServerEntry,
  previousName: string,
): NekMcpServerEntry[] {
  const exists = servers.some((server) => server.name === previousName);
  return exists
    ? servers.map((server) => (server.name === previousName ? entry : server))
    : [...servers, entry];
}

function applyOverride(
  server: NekMcpServerEntry,
  override: NekMcpServerOverride,
): NekMcpServerEntry {
  return {
    ...server,
    config: { ...server.config, ...override },
    ...(server.isOverride ? { override: { ...server.override, ...override } } : {}),
  };
}

export function useNekMcpDoc(scope: NekConfigScope = "global", cwd?: string): NekMcpDocument {
  const { config, target } = useNekSettingsContext();
  const doc = useNekDocument<NekMcpConfigView>({
    load: (api, current) => api.readMcpConfig(current, scope, cwd),
    deps: [scope, cwd],
    enabled: scope === "global" || Boolean(cwd),
  });
  const { mutate } = doc;

  const saveServer = useCallback(
    (entry: McpWrite) =>
      mutate({
        optimistic: (data) => {
          const { name, config: value, previousName } = entry;
          if (scope !== "global" || !("command" in value || "url" in value)) return data;
          return {
            ...data,
            servers: upsertServer(
              data.servers,
              { name, scope, path: data.path, config: value, isOverride: false },
              previousName ?? name,
            ),
          };
        },
        write: (data) =>
          config.saveMcpServer(target, scope, entry, { revision: data.revision, cwd }),
      }),
    [config, target, scope, cwd, mutate],
  );

  const deleteServer = useCallback(
    (name: string) =>
      mutate({
        optimistic: (data) => ({
          ...data,
          servers: data.servers.filter((server) => server.name !== name),
        }),
        write: (data) =>
          config.deleteMcpServer(target, scope, name, { revision: data.revision, cwd }),
      }),
    [config, target, scope, cwd, mutate],
  );

  const setOverride = useCallback(
    (name: string, override: NekMcpServerOverride) =>
      mutate({
        optimistic: (data) => ({
          ...data,
          servers: data.servers.map((server) =>
            server.name === name ? applyOverride(server, override) : server,
          ),
        }),
        write: (data) =>
          config.setMcpServerOverride(target, name, override, {
            revision: data.revision,
            scope,
            cwd,
          }),
      }),
    [config, target, scope, cwd, mutate],
  );

  return useMemo(
    () => ({ ...doc, scope, saveServer, deleteServer, setOverride }),
    [doc, scope, saveServer, deleteServer, setOverride],
  );
}

// ---------------------------------------------------------------------------
// 子代理预设
// ---------------------------------------------------------------------------

export interface NekAgentPresetsDocument extends NekDocument<NekAgentPresetsView> {
  savePreset: (scope: NekConfigScope, preset: NekAgentPreset, path?: string) => Promise<void>;
  deletePreset: (scope: NekConfigScope, file: { path: string; revision: string }) => Promise<void>;
}

export function useNekAgentPresetsDoc(cwd?: string): NekAgentPresetsDocument {
  const { config, target } = useNekSettingsContext();
  const doc = useNekDocument<NekAgentPresetsView>({
    load: (api, current) => api.listAgentPresets(current, cwd),
    deps: [cwd],
    matchesFile: (file, _data, scope) => {
      if (scope === "project" && !cwd) return false;
      const normalized = normalizeConfigPath(file);
      return (
        /\/agents\/[^/]+\.md$/u.test(normalized) ||
        (Boolean(cwd) && /\/(?:trust|settings)\.json$/u.test(normalized))
      );
    },
  });
  const { mutate } = doc;

  const savePreset = useCallback(
    (scope: NekConfigScope, preset: NekAgentPreset, path?: string) =>
      mutate({
        // The host owns the winner, tools and path of the saved row. Do not guess them optimistically.
        write: async (data) => {
          const previous = path ? data.entries.find((entry) => entry.path === path) : undefined;
          if (path && !previous)
            throw new NekConfigApiError("validation", `Preset file no longer listed: ${path}`);
          const result = await config.saveAgentPreset(target, scope, preset, {
            revision: previous?.revision ?? "absent",
            cwd,
          });
          return { fileRevision: result.revision };
        },
      }),
    [config, target, cwd, mutate],
  );

  const deletePreset = useCallback(
    (scope: NekConfigScope, file: { path: string; revision: string }) =>
      mutate({
        write: async () => {
          await config.deleteAgentPreset(target, scope, file.path, {
            revision: file.revision,
            cwd,
          });
        },
      }),
    [config, target, cwd, mutate],
  );

  return useMemo(() => ({ ...doc, savePreset, deletePreset }), [doc, savePreset, deletePreset]);
}
