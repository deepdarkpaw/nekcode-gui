/**
 * settings.json / nek.yaml / 指令文件（AGENTS.md）的文档 hooks。
 */
import { useCallback, useMemo } from "react";
import type {
  NekConfigScope,
  NekSettingsPatch,
  NekSettingsReadResult,
  NekSettingsView,
  NekYamlPatch,
  NekYamlReadResult,
  NekYamlView,
  NekConfigRevision,
} from "@zcode/shared/nek-protocol";
import { applySettingsPatch, mergeDeep } from "../lib/settingsPatch.js";
import { useNekSettingsContext } from "./NekSettingsContext.js";
import { useNekDocument, type NekDocument } from "./useNekDocument.js";

export interface NekSettingsDocument extends NekDocument<NekSettingsReadResult> {
  scope: NekConfigScope;
  patch: (patch: NekSettingsPatch) => Promise<void>;
}

/** settings.json；项目作用域需要 cwd。 */
export function useNekSettingsDoc(
  scope: NekConfigScope = "global",
  cwd?: string,
): NekSettingsDocument {
  const { config, target } = useNekSettingsContext();
  const doc = useNekDocument<NekSettingsReadResult>({
    load: (api, current) => api.readSettings(current, scope, cwd),
    deps: [scope, cwd],
    enabled: scope === "global" || Boolean(cwd),
  });
  const { mutate } = doc;
  const patch = useCallback(
    (settingsPatch: NekSettingsPatch) =>
      mutate({
        optimistic: (data) => ({
          ...data,
          values: applySettingsPatch(data.values, settingsPatch),
          effective: applySettingsPatch(data.effective, settingsPatch),
        }),
        write: (data) =>
          config.patchSettings(target, scope, settingsPatch, { revision: data.revision, cwd }),
      }),
    [config, target, scope, cwd, mutate],
  );
  return useMemo(() => ({ ...doc, scope, patch }), [doc, scope, patch]);
}

/** 取值：文件里写了用文件值，否则用 nek 默认值。 */
export function settingOrDefault<V>(
  data: NekSettingsReadResult | undefined,
  select: (view: NekSettingsView) => V | undefined,
): V | undefined {
  if (!data) {
    return undefined;
  }
  return select(data.values) ?? select(data.defaults);
}

export interface NekYamlDocument extends NekDocument<NekYamlReadResult> {
  patch: (patch: NekYamlPatch) => Promise<void>;
}

export function useNekYamlDoc(scope: NekConfigScope = "global", cwd?: string): NekYamlDocument {
  const { config, target } = useNekSettingsContext();
  const doc = useNekDocument<NekYamlReadResult>({
    load: (api, current) => api.readNekYaml(current, scope, cwd),
    deps: [scope, cwd],
    enabled: scope === "global" || Boolean(cwd),
  });
  const { mutate } = doc;
  const patch = useCallback(
    (yamlPatch: NekYamlPatch) =>
      mutate({
        optimistic: (data) => ({
          ...data,
          values: mergeDeep(data.values, yamlPatch) as NekYamlReadResult["values"],
        }),
        write: (data) =>
          config.patchNekYaml(target, scope, yamlPatch, { revision: data.revision, cwd }),
      }),
    [config, target, scope, cwd, mutate],
  );
  return useMemo(() => ({ ...doc, patch }), [doc, patch]);
}

/** nek.yaml 生效值：文件值覆盖默认值。 */
export function yamlValue<K extends keyof NekYamlView, F extends keyof NekYamlView[K]>(
  data: NekYamlReadResult | undefined,
  section: K,
  field: F,
): NekYamlView[K][F] | undefined {
  if (!data) {
    return undefined;
  }
  const value = data.values[section]?.[field];
  return (value ?? data.defaults[section][field]) as NekYamlView[K][F];
}

type InstructionsData = NekConfigRevision & { path: string; content: string };

export interface NekInstructionsDocument extends NekDocument<InstructionsData> {
  save: (content: string) => Promise<void>;
}

export function useNekInstructionsDoc(
  scope: NekConfigScope = "global",
  cwd?: string,
): NekInstructionsDocument {
  const { config, target } = useNekSettingsContext();
  const doc = useNekDocument<InstructionsData>({
    load: (api, current) => api.readInstructions(current, scope, cwd),
    deps: [scope, cwd],
    enabled: scope === "global" || Boolean(cwd),
  });
  const { mutate } = doc;
  const save = useCallback(
    (content: string) =>
      mutate({
        // 待保存正文由 InstructionsEditor 的草稿持有，文档只在写后真实读取时更新。
        write: (data) =>
          config.writeInstructions(target, scope, content, { revision: data.revision, cwd }),
      }),
    [config, target, scope, cwd, mutate],
  );
  return useMemo(() => ({ ...doc, save }), [doc, save]);
}
