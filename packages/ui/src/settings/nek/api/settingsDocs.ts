/**
 * settings.json / nek.yaml / 指令文件的文档 hooks。
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
  NekInstructionsView,
} from "@zcode/shared/nek-protocol";
import { NEK_INSTRUCTION_FILE_NAMES } from "@zcode/shared/nek-protocol";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { applySettingsPatch, mergeDeep } from "../lib/settingsPatch.js";
import { useNekSettingsContext } from "./NekSettingsContext.js";
import { NekConfigApiError } from "./nekErrors.js";
import { normalizeConfigPath, useNekDocument, type NekDocument } from "./useNekDocument.js";

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

const INSTRUCTION_NAMES = new Set<string>(
  NEK_INSTRUCTION_FILE_NAMES.map((name) => name.toLowerCase()),
);

export interface NekInstructionsDocument extends NekDocument<NekInstructionsView> {
  save: (content: string, path: string) => Promise<void>;
}

export function useNekInstructionsDoc(
  scope: NekConfigScope = "global",
  cwd?: string,
): NekInstructionsDocument {
  const { config, target } = useNekSettingsContext();
  const { intl } = useZCodeIntl();
  const doc = useNekDocument<NekInstructionsView>({
    load: (api, current) => api.readInstructions(current, scope, cwd),
    deps: [scope, cwd],
    enabled: scope === "global" || Boolean(cwd),
    matchesFile: (file, data) => {
      const path = normalizeConfigPath(file);
      const activePath = normalizeConfigPath(data.path);
      const slash = path.lastIndexOf("/");
      return (
        path.slice(0, slash) === activePath.slice(0, activePath.lastIndexOf("/")) &&
        INSTRUCTION_NAMES.has(path.slice(slash + 1))
      );
    },
  });
  const { mutate } = doc;
  const save = useCallback(
    (content: string, path: string) =>
      mutate({
        // Saving or keeping a draft must never redirect it to a different winning file.
        write: (data) => {
          if (data.path !== path)
            throw new NekConfigApiError(
              "validation",
              intl.formatMessage({ id: "settings.nek.instructions.fileChanged" }, { path }),
            );
          return config.writeInstructions(target, scope, content, {
            path,
            revision: data.revision,
            cwd,
          });
        },
      }),
    [config, target, scope, cwd, mutate, intl],
  );
  return useMemo(() => ({ ...doc, save }), [doc, save]);
}
