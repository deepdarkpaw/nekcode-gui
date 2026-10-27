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
import { nekSettingsFileSchema, parseWithSchema } from "../nek-agent/config/schemas.js";
import { diagnostic, mergeDeep } from "./documents.js";
import { fieldErrorsOf, validationError } from "./errors.js";
import { settingsPath } from "./paths.js";
import type { NekConfigRuntime } from "./runtime.js";
import {
  NEK_SETTINGS_DEFAULTS,
  settingsPatchToRecord,
  toSettingsView,
} from "./settingsDefaults.js";
import { patchSettingsDocument, readSettingsDocument } from "./settingsDocument.js";

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

/** 删除标记（`null`）不能出现在校验对象里：它不是合法的 settings 值。 */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) continue;
    result[key] = stripNulls(entry);
  }
  return result;
}

export function validateSettingsPatch(record: Record<string, unknown>): void {
  const validated = parseWithSchema(nekSettingsFileSchema, stripNulls(record));
  if (validated.ok) return;
  throw validationError("invalid settings patch", fieldErrorsOf(validated.issues));
}

export function createSettingsGroup(runtime: NekConfigRuntime): NekSettingsGroup {
  const defaultsRecord = NEK_SETTINGS_DEFAULTS as unknown as Record<string, unknown>;

  return {
    readSettings: async (target, scope, cwd) => {
      const context = runtime.target(target);
      runtime.rememberCwd(target, cwd);
      if (scope === "project" && !cwd) {
        throw validationError("project scope requires cwd", { cwd: "required" });
      }
      const path = settingsPath(context.layout, scope, cwd);
      const document = await readSettingsDocument(context.executor, path);
      const diagnostics: NekConfigDiagnostic[] = [];
      const readScope = async (otherScope: NekConfigScope): Promise<Record<string, unknown>> => {
        if (otherScope === "project" && !cwd) return {};
        const otherPath = settingsPath(context.layout, otherScope, cwd);
        if (otherScope === scope) return document.raw;
        try {
          return (await readSettingsDocument(context.executor, otherPath)).raw;
        } catch (error) {
          diagnostics.push(
            diagnostic(otherPath, error instanceof Error ? error.message : String(error)),
          );
          return {};
        }
      };
      const global = await readScope("global");
      const project = await readScope("project");
      const effective = mergeDeep(mergeDeep(defaultsRecord, global), project);
      const values: NekSettingsView = document.values;
      return {
        path,
        revision: document.revision,
        scope,
        values,
        effective: toSettingsView(effective),
        defaults: NEK_SETTINGS_DEFAULTS,
        diagnostics,
      };
    },

    patchSettings: async (target, scope, patch, options) => {
      const context = runtime.target(target);
      runtime.rememberCwd(target, options.cwd);
      if (scope === "project" && !options.cwd) {
        throw validationError("project scope requires cwd", { cwd: "required" });
      }
      const record = settingsPatchToRecord(patch as Record<string, unknown>);
      validateSettingsPatch(record);
      const patched = await patchSettingsDocument({
        executor: context.executor,
        path: settingsPath(context.layout, scope, options.cwd),
        patch: record,
        expectedRevision: options.revision,
      });
      runtime.publishWrite(target, [patched]);
      return { revision: patched.revision };
    },
  };
}
