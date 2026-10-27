/**
 * 文档级原语：读快照、revision 校验、原子写、JSON/JSONC/YAML 解析、settings 补丁合并。
 *
 * 所有写路径都满足三条硬规则（ARD §3）：
 * 1. 写入一律 `.tmp` + rename（由执行器的 `writeFileAtomic` 保证）；
 * 2. 写入前比对读取时拿到的 revision，被外部改过就抛 `conflict`；
 * 3. 解析失败不落盘：宁可报错也不写一个 nek 读不了的文件。
 */
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import { parse as parseYaml } from "yaml";
import type { NekConfigDiagnostic } from "@zcode/shared/nek-protocol";
import { isPlainObject, stripBom } from "../nek-agent/config/nekConfigDocuments.js";
import { conflict, validationError } from "./errors.js";
import { ABSENT_REVISION, encodeRevision, sameRevision } from "./revision.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";

/** 一次读取的结果：`content === null` 表示文件不存在（revision 为 `absent`）。 */
export interface NekTextDocument {
  path: string;
  content: string | null;
  revision: string;
  mtimeMs: number;
  size: number;
}

const JSON_FORMATTING = { insertSpaces: true, tabSize: 2, eol: "\n" } as const;

export async function readTextDocument(
  executor: NekConfigHostExecutor,
  path: string,
): Promise<NekTextDocument> {
  const content = await executor.readFile(path);
  if (content === null) {
    return { path, content: null, revision: ABSENT_REVISION, mtimeMs: 0, size: 0 };
  }
  const info = await executor.stat(path);
  const mtimeMs = info?.mtimeMs ?? 0;
  const size = info?.size ?? Buffer.byteLength(content, "utf8");
  return { path, content, revision: encodeRevision({ mtimeMs, size }, content), mtimeMs, size };
}

/** 写入并返回新 revision；内容为空且文件原本不存在时也照写（空配置是合法的）。 */
export async function writeTextDocument(
  executor: NekConfigHostExecutor,
  path: string,
  content: string,
): Promise<string> {
  await executor.writeFileAtomic(path, content);
  const info = await executor.stat(path);
  return encodeRevision(
    { mtimeMs: info?.mtimeMs ?? 0, size: info?.size ?? Buffer.byteLength(content, "utf8") },
    content,
  );
}

/** 读取 + 校验 revision：读到的令牌与调用方持有的不一致就抛 `conflict`。 */
export async function readCheckedDocument(
  executor: NekConfigHostExecutor,
  path: string,
  expected: string,
): Promise<NekTextDocument> {
  const document = await readTextDocument(executor, path);
  if (!sameRevision(document.revision, expected)) throw conflict(path);
  return document;
}

export function parseJsonMapping(path: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch (error) {
    throw validationError(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
      [path]: "invalid JSON",
    });
  }
  if (!isPlainObject(parsed)) throw validationError(`${path}: expected a JSON object`);
  return parsed;
}

/** models.json 允许 `//` 注释（nek 用 `stripJsonComments` 读），这里允许注释与尾逗号。 */
export function parseJsoncMapping(path: string, text: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(stripBom(text), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0];
    const detail = first ? printParseErrorCode(first.error) : "invalid JSON";
    throw validationError(`${path}: ${detail}`, { [path]: detail });
  }
  if (parsed === undefined || parsed === null) return {};
  if (!isPlainObject(parsed)) throw validationError(`${path}: expected a JSON object`);
  return parsed;
}

export function parseYamlMapping(path: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = parseYaml(stripBom(text));
  } catch (error) {
    throw validationError(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
      [path]: "invalid YAML",
    });
  }
  if (parsed === undefined || parsed === null) return {};
  if (!isPlainObject(parsed)) throw validationError(`${path}: expected a mapping`);
  return parsed;
}

/**
 * 对 JSONC 原文做一次文本编辑（保留注释、未知字段与键顺序）。
 *
 * 编辑前后都校验可解析性：坏文件被"修一半"比直接报错更难排查。
 */
export function applyJsoncEdit(
  path: string,
  text: string,
  pointer: Array<string | number>,
  value: unknown,
): string {
  parseJsoncMapping(path, text);
  const next = applyEdits(
    text,
    modify(text, pointer, value, { formattingOptions: JSON_FORMATTING }),
  );
  parseJsoncMapping(path, next);
  return next;
}

/** 空 models.json 的初始文本（与 `one-provider` 的排版一致）。 */
export const EMPTY_MODELS_TEXT = '{\n  "providers": {}\n}\n';

/**
 * settings 补丁合并：嵌套对象逐键合并，`null` 删除该键（任意深度）。
 *
 * 与 nek `persistScopedSettings` 的差别只有一处：nek 用 `undefined` 表示删除，
 * 而契约用 `null`（JSON 里没有 undefined）。合并后仍有 `null` 说明补丁里有非法的数组元素，
 * 直接报错而不是把 null 写进文件。
 */
export function applySettingsPatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = mergeObject(current, patch);
  assertNoNull(merged, "");
  return merged;
}

function mergeObject(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete merged[key];
      continue;
    }
    const base = merged[key];
    merged[key] = isPlainObject(base) && isPlainObject(value) ? mergeObject(base, value) : value;
  }
  return merged;
}

function assertNoNull(value: unknown, path: string): void {
  if (value === null) {
    throw validationError(`null is not allowed at ${path || "(root)"}`, {
      [path || "(root)"]: "null means delete and must not be persisted",
    });
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) assertNoNull(entry, `${path}[${index}]`);
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertNoNull(entry, path === "" ? key : `${path}.${key}`);
    }
  }
}

/** 深度合并（后者覆盖前者；数组整体替换）。用于 settings 的 global → project → defaults 叠加。 */
export function mergeDeep(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] =
      isPlainObject(current) && isPlainObject(value) ? mergeDeep(current, value) : value;
  }
  return merged;
}

export function diagnostic(
  file: string,
  message: string,
  severity: NekConfigDiagnostic["severity"] = "error",
): NekConfigDiagnostic {
  return { file, severity, message };
}
