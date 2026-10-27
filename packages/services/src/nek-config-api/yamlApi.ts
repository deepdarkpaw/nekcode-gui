/**
 * nek.yaml（nek 扩展自身的设置：plan / todo / subagent）。
 *
 * 与 settings.json 的区别：这里没有锁（nek 只在启动时读），写回用 `yaml` 库序列化后原子替换。
 * 补丁语义与 settings 相同（嵌套合并、`null` 删除），未识别的顶层键原样保留。
 */
import type {
  NekConfigRevision,
  NekConfigScope,
  NekConfigTarget,
  NekYamlPatch,
  NekYamlReadResult,
  NekYamlView,
} from "@zcode/shared/nek-protocol";
import { stringify as stringifyYaml } from "yaml";
import {
  applySettingsPatch,
  parseYamlMapping,
  readTextDocument,
  writeTextDocument,
} from "./documents.js";
import { conflict, validationError } from "./errors.js";
import { fieldErrorsOf, asNekConfigError } from "./errors.js";
import { nekYamlSchema, parseWithSchema } from "../nek-agent/config/schemas.js";
import { nekYamlPath } from "./paths.js";
import type { NekConfigRuntime } from "./runtime.js";
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";

/** nek `DEFAULT_NEK_CONFIG`（`extensions/nek/config.ts`）。 */
export const NEK_YAML_DEFAULTS: NekYamlView = {
  plan: { dir: ".nek/plans", shortcut: "alt+m" },
  todo: { settleReminder: true, widgetMaxLines: 8 },
  subagent: {
    maxConcurrent: 6,
    maxRetained: 32,
    awaitDefaultMs: 30_000,
    awaitMaxMs: 7_140_000,
    finalTextMaxBytes: 32_768,
  },
};

const SECTIONS = Object.keys(NEK_YAML_DEFAULTS) as Array<keyof NekYamlView>;

export interface NekYamlGroup {
  readNekYaml: (
    target: NekConfigTarget,
    scope: NekConfigScope,
    cwd?: string,
  ) => Promise<NekYamlReadResult>;
  patchNekYaml: (
    target: NekConfigTarget,
    scope: NekConfigScope,
    patch: NekYamlPatch,
    options: { revision: string; cwd?: string },
  ) => Promise<NekConfigRevision>;
}

/** 只带出认识的 section/key（未知键留在原文里，补丁不会碰它们）。 */
function toYamlValues(raw: Record<string, unknown>): NekYamlReadResult["values"] {
  const values: Record<string, Record<string, unknown>> = {};
  for (const section of SECTIONS) {
    const entry = raw[section];
    if (!isPlainObject(entry)) continue;
    const defaults = NEK_YAML_DEFAULTS[section] as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const key of Object.keys(defaults)) {
      if (key in entry) picked[key] = entry[key];
    }
    if (Object.keys(picked).length > 0) values[section] = picked;
  }
  return values as NekYamlReadResult["values"];
}

function validatePatch(record: Record<string, unknown>): void {
  // nek 对未知 section/key 会直接抛错，GUI 提前拦住，避免"保存成功但 nek 起不来"。
  for (const [section, value] of Object.entries(record)) {
    if (!(SECTIONS as string[]).includes(section)) {
      throw validationError(`unknown nek.yaml section "${section}"`, {
        [section]: `allowed: ${SECTIONS.join(", ")}`,
      });
    }
    if (!isPlainObject(value)) {
      throw validationError(`nek.yaml "${section}" must be a mapping`, {
        [section]: "must be a mapping",
      });
    }
    const defaults = NEK_YAML_DEFAULTS[section as keyof NekYamlView] as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value)) {
      if (!(key in defaults)) {
        throw validationError(`unknown nek.yaml key "${section}.${key}"`, {
          [`${section}.${key}`]: `allowed: ${Object.keys(defaults).join(", ")}`,
        });
      }
      if (typeof entry !== typeof defaults[key]) {
        throw validationError(`nek.yaml "${section}.${key}" must be a ${typeof defaults[key]}`, {
          [`${section}.${key}`]: `expected ${typeof defaults[key]}`,
        });
      }
      if (typeof entry === "number" && !(Number.isFinite(entry) && entry >= 0)) {
        throw validationError(`nek.yaml "${section}.${key}" must be a non-negative number`, {
          [`${section}.${key}`]: "non-negative number",
        });
      }
    }
  }
  const validated = parseWithSchema(nekYamlSchema, record);
  if (!validated.ok)
    throw validationError("invalid nek.yaml patch", fieldErrorsOf(validated.issues));
}

export function createYamlGroup(runtime: NekConfigRuntime): NekYamlGroup {
  return {
    readNekYaml: async (target, scope, cwd) => {
      const context = runtime.target(target);
      runtime.rememberCwd(target, cwd);
      const path = nekYamlPath(context.layout, scope, cwd);
      const document = await readTextDocument(context.executor, path);
      if (document.content === null || document.content.trim() === "") {
        return {
          path,
          revision: document.revision,
          scope,
          values: {},
          defaults: NEK_YAML_DEFAULTS,
          diagnostics: [],
        };
      }
      try {
        const raw = parseYamlMapping(path, document.content);
        return {
          path,
          revision: document.revision,
          scope,
          values: toYamlValues(raw),
          defaults: NEK_YAML_DEFAULTS,
          diagnostics: [],
        };
      } catch (error) {
        const normalized = asNekConfigError(error);
        return {
          path,
          revision: document.revision,
          scope,
          values: {},
          defaults: NEK_YAML_DEFAULTS,
          diagnostics: [{ file: path, severity: "error", message: normalized.message }],
        };
      }
    },

    patchNekYaml: async (target, scope, patch, options) => {
      const context = runtime.target(target);
      runtime.rememberCwd(target, options.cwd);
      const path = nekYamlPath(context.layout, scope, options.cwd);
      const document = await readTextDocument(context.executor, path);
      if (document.revision !== options.revision) throw conflict(path);
      const current =
        document.content === null || document.content.trim() === ""
          ? {}
          : parseYamlMapping(path, document.content);
      const record = patch as Record<string, unknown>;
      validatePatch(record);
      const merged = applySettingsPatch(current, record);
      const revision = await writeTextDocument(context.executor, path, stringifyYaml(merged));
      runtime.publishWrite(target, [{ path, revision }]);
      return { revision };
    },
  };
}
