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

/**
 * nek 的 web_search 只要出现 apiKey/endpoint 就必须有显式 provider（否则会话启动失败），
 * 但这条规则是**跨字段、跨作用域**的：项目层的 key 可以继承全局的 provider。
 *
 * 所以校验放在合并后的结果上，并且只在"这次写入新引入了非法组合"时失败：
 * 历史配置里已经存在 apiKey 没有 provider 时，改主题、改模型这些无关字段不能被连带拒绝，
 * 否则用户必须先跑去修联网搜索才能保存任何设置。空字符串/null 视为未配置。
 */
function hasWebSearchProviderIssue(record: Record<string, unknown>): boolean {
  const web = toSettingsView(record).webSearch;
  return web?.provider === undefined && Boolean(web?.apiKey || web?.endpoint);
}

function webSearchProviderError(): Error {
  return validationError(
    "Select a web search provider explicitly before setting its API key or endpoint",
    { "webSearch.provider": "Required when webSearch.apiKey or webSearch.endpoint is configured" },
  );
}

/** 补丁前的合并结果已经非法时不再重复报错；新引入的非法组合仍然拒绝写入。 */
function validateWebSearchMerge(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): void {
  if (!hasWebSearchProviderIssue(next)) return;
  if (hasWebSearchProviderIssue(previous)) return;
  throw webSearchProviderError();
}

export function createSettingsGroup(runtime: NekConfigRuntime): NekSettingsGroup {
  const defaultsRecord = NEK_SETTINGS_DEFAULTS as unknown as Record<string, unknown>;

  return {
    readSettings: async (target, scope, cwd) => {
      const context = runtime.target(target);
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
      const explicit = mergeDeep(global, project);
      if (hasWebSearchProviderIssue(explicit)) {
        diagnostics.push(diagnostic(path, webSearchProviderError().message));
      }
      const effective = mergeDeep(defaultsRecord, explicit);
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
      if (scope === "project" && !options.cwd) {
        throw validationError("project scope requires cwd", { cwd: "required" });
      }
      const record = settingsPatchToRecord(patch as Record<string, unknown>);
      validateSettingsPatch(record);
      const inherited =
        scope === "project"
          ? (await readSettingsDocument(context.executor, settingsPath(context.layout, "global")))
              .raw
          : {};
      const patched = await patchSettingsDocument({
        executor: context.executor,
        path: settingsPath(context.layout, scope, options.cwd),
        patch: record,
        expectedRevision: options.revision,
        validate: (merged, previous) =>
          validateWebSearchMerge(mergeDeep(inherited, previous), mergeDeep(inherited, merged)),
      });
      runtime.publishWrite(target, [patched]);
      return { revision: patched.revision };
    },
  };
}
