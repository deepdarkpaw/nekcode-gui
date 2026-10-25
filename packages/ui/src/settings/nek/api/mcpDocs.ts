/**
 * mcp.json 与子代理预设（agents/*.md）的文档 hooks。
 */
import { useCallback, useMemo } from "react";
import type {
  NekAgentPreset,
  NekAgentPresetEntry,
  NekConfigScope,
  NekMcpConfigView,
  NekMcpExposure,
  NekMcpServerConfig,
  NekMcpServerEntry,
} from "@zcode/shared/nek-protocol";
import { useNekSettingsContext } from "./NekSettingsContext.js";
import { normalizeConfigPath, useNekDocument, type NekDocument } from "./useNekDocument.js";

export interface McpOverride {
  enabled?: boolean;
  exposure?: NekMcpExposure;
  toolExposure?: Record<string, NekMcpExposure>;
}

export interface NekMcpDocument extends NekDocument<NekMcpConfigView> {
  scope: NekConfigScope;
  saveServer: (entry: {
    name: string;
    config: NekMcpServerConfig;
    previousName?: string;
  }) => Promise<void>;
  deleteServer: (name: string) => Promise<void>;
  setOverride: (name: string, override: McpOverride) => Promise<void>;
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

function applyOverride(server: NekMcpServerEntry, override: McpOverride): NekMcpServerEntry {
  return { ...server, config: { ...server.config, ...override } };
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
    (entry: { name: string; config: NekMcpServerConfig; previousName?: string }) =>
      mutate({
        optimistic: (data) => ({
          ...data,
          servers: upsertServer(
            data.servers,
            { name: entry.name, scope, config: entry.config, isOverride: false },
            entry.previousName ?? entry.name,
          ),
        }),
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
    (name: string, override: McpOverride) =>
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

export interface AgentPresetsData {
  /** 组合 revision（各文件 revision 拼接），仅用于识别变化。 */
  revision: string;
  entries: NekAgentPresetEntry[];
}

export interface NekAgentPresetsDocument extends NekDocument<AgentPresetsData> {
  savePreset: (
    scope: NekConfigScope,
    preset: NekAgentPreset,
    previousName?: string,
  ) => Promise<void>;
  deletePreset: (scope: NekConfigScope, name: string) => Promise<void>;
}

function sourceOf(scope: NekConfigScope): NekAgentPresetEntry["source"] {
  return scope === "project" ? "project" : "user";
}

function findEntry(data: AgentPresetsData, scope: NekConfigScope, name: string) {
  return data.entries.find(
    (entry) => entry.source === sourceOf(scope) && entry.preset.name === name,
  );
}

/** 预设文件位于 `agents/` 目录（全局或项目 `.nek/agents/`）。 */
function isAgentsFile(file: string): boolean {
  return /\/agents\/[^/]+\.md$/.test(normalizeConfigPath(file));
}

export function useNekAgentPresetsDoc(cwd?: string): NekAgentPresetsDocument {
  const { config, target } = useNekSettingsContext();
  const doc = useNekDocument<AgentPresetsData>({
    load: async (api, current) => {
      const entries = await api.listAgentPresets(current, cwd);
      return { revision: entries.map((entry) => entry.revision).join("|"), entries };
    },
    deps: [cwd],
    matchesFile: (file) => isAgentsFile(file),
  });
  const { mutate } = doc;

  const savePreset = useCallback(
    (scope: NekConfigScope, preset: NekAgentPreset, previousName?: string) =>
      mutate({
        optimistic: (data) => {
          const previous = findEntry(data, scope, previousName ?? preset.name);
          const entry: NekAgentPresetEntry = {
            source: sourceOf(scope),
            path: previous?.path,
            revision: previous?.revision ?? "absent",
            preset,
          };
          return {
            ...data,
            entries: previous
              ? data.entries.map((item) => (item === previous ? entry : item))
              : [...data.entries, entry],
          };
        },
        write: async (data) => {
          const previous = findEntry(data, scope, previousName ?? preset.name);
          const result = await config.saveAgentPreset(target, scope, preset, {
            revision: previous?.revision ?? "absent",
            previousName,
            cwd,
          });
          return { fileRevision: result.revision };
        },
      }),
    [config, target, cwd, mutate],
  );

  const deletePreset = useCallback(
    (scope: NekConfigScope, name: string) =>
      mutate({
        optimistic: (data) => ({
          ...data,
          entries: data.entries.filter((entry) => entry !== findEntry(data, scope, name)),
        }),
        write: async (data) => {
          const entry = findEntry(data, scope, name);
          const result = await config.deleteAgentPreset(target, scope, name, {
            revision: entry?.revision ?? "absent",
            cwd,
          });
          return { fileRevision: result.revision };
        },
      }),
    [config, target, cwd, mutate],
  );

  return useMemo(() => ({ ...doc, savePreset, deletePreset }), [doc, savePreset, deletePreset]);
}
