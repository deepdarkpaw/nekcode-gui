/**
 * settings.json 的读写接口。
 *
 * `readSettings` 返回四部分：本作用域写了什么（values）、合并后的生效值（effective）、
 * nek 默认值（defaults）、诊断（diagnostics）。界面靠这三层显示"继承自全局 / 恢复默认"。
 */
import type {
  NekConfigDiagnostic,
  NekConfigRevision,
  NekConfigScope,
  NekConfigTarget,
  NekSettingsPatch,
  NekSettingsReadResult,
  NekSettingsView,
} from "@zcode/shared/nek-protocol";
import { diagnostic, mergeDeep } from "./documents.js";
import { validationError } from "./errors.js";
import { settingsPath } from "./paths.js";
import type { NekConfigRuntime } from "./runtime.js";
import {
  loadNekSettings,
  NEK_SETTINGS_DEFAULTS,
  settingsPatchToRecord,
  toEffectiveSettingsView,
} from "./settingsDefaults.js";
import { patchSettingsDocument, readSettingsDocument } from "./settingsDocument.js";
import { assertSettingsProjectTrusted, settingsProjectTrusted } from "./settingsProjectTrust.js";
import {
  resolveWebSearchCapabilities,
  settingsRuleDiagnostics,
  validateWebSearchMerge,
  webSearchMergeDiagnostics,
  type WebSearchCapabilities,
} from "./settingsValidation.js";

export {
  assertWebSearchProbeSupported,
  resolveWebSearchCapabilities,
} from "./settingsValidation.js";

export interface NekSettingsGroup {
  readSettings: (
    target: NekConfigTarget,
    scope: NekConfigScope,
    cwd?: string,
  ) => Promise<NekSettingsReadResult>;
  patchSettings: (
    target: NekConfigTarget,
    scope: NekConfigScope,
    patch: NekSettingsPatch,
    options: { revision: string; cwd?: string },
  ) => Promise<NekConfigRevision>;
}

export function createSettingsGroup(runtime: NekConfigRuntime): NekSettingsGroup {
  return {
    readSettings: async (target, scope, cwd) => {
      const context = runtime.target(target);
      if (scope === "project" && !cwd) {
        throw validationError("project scope requires cwd", { cwd: "required" });
      }
      const path = settingsPath(context.layout, scope, cwd);
      const document = await readSettingsDocument(context.executor, path);
      const diagnostics: NekConfigDiagnostic[] = settingsRuleDiagnostics(path, document.raw, scope);
      const readScope = async (otherScope: NekConfigScope): Promise<Record<string, unknown>> => {
        if (otherScope === "project" && !cwd) return {};
        const otherPath = settingsPath(context.layout, otherScope, cwd);
        if (otherScope === scope) return loadNekSettings(document.raw);
        try {
          const { raw } = await readSettingsDocument(context.executor, otherPath);
          diagnostics.push(...settingsRuleDiagnostics(otherPath, raw, otherScope));
          return loadNekSettings(raw);
        } catch (error) {
          diagnostics.push(
            diagnostic(otherPath, error instanceof Error ? error.message : String(error)),
          );
          return {};
        }
      };
      const global = await readScope("global");
      const projectTrusted = cwd ? await settingsProjectTrusted(runtime, context, cwd) : undefined;
      const project = projectTrusted ? await readScope("project") : {};
      const explicit = mergeDeep(global, project);
      diagnostics.push(...webSearchMergeDiagnostics(path, explicit));
      const values: NekSettingsView = document.values;
      return {
        path,
        revision: document.revision,
        scope,
        values,
        effective: toEffectiveSettingsView(explicit),
        ...(projectTrusted === undefined ? {} : { projectTrusted }),
        defaults: NEK_SETTINGS_DEFAULTS,
        diagnostics,
      };
    },

    patchSettings: async (target, scope, patch, options) => {
      const context = runtime.target(target);
      if (scope === "project" && !options.cwd) {
        throw validationError("project scope requires cwd", { cwd: "required" });
      }
      await assertSettingsProjectTrusted(runtime, context, scope, options.cwd);
      const record = settingsPatchToRecord(patch as Record<string, unknown>);
      const inherited =
        scope === "project"
          ? (await readSettingsDocument(context.executor, settingsPath(context.layout, "global")))
              .raw
          : {};
      // 只有会碰到搜索配置的写入才需要目标版本：目标表要经过 host（远程是 SSH），
      // 普通设置的补丁不该为了一次能力判断多跑一趟。
      let capabilities: WebSearchCapabilities = { tavily: true, nekVersion: undefined };
      if ("webSearch" in record) {
        capabilities = await resolveWebSearchCapabilities(runtime, target);
      }
      const patched = await patchSettingsDocument({
        executor: context.executor,
        path: settingsPath(context.layout, scope, options.cwd),
        patch: record,
        expectedRevision: options.revision,
        scope,
        validate: (merged, previous) =>
          validateWebSearchMerge(
            mergeDeep(inherited, previous),
            mergeDeep(inherited, merged),
            capabilities,
          ),
      });
      runtime.publishWrite(target, [patched]);
      return { revision: patched.revision };
    },
  };
}
