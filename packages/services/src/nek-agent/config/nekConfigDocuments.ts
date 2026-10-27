import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { NekConfigParseError } from "./nekConfigFs.js";

/**
 * 配置文本的纯函数工具：settings 合并规则、JSON 读取、`agents/*.md` 的 frontmatter 解析/序列化。
 *
 * 与 nek 对齐的两处语义：
 * - settings 合并时"顶层键整体替换、嵌套对象按子键合并"（`persistScopedSettings`）；
 * - agent 文件的 frontmatter 是 YAML，正文原样保留。
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 去掉 BOM：nek 读 JSON 前同样会 stripBom。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * settings 的合并规则（与 nek `persistScopedSettings` 一致）：
 * 顶层键整体替换；键值双方都是对象时按子键合并；子键值为 `undefined` 表示删除该子键。
 */
export function mergeSettingsPatch(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  replaceKeys: readonly string[] = [],
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete merged[key];
      continue;
    }
    const base = merged[key];
    if (isPlainObject(base) && isPlainObject(value) && !replaceKeys.includes(key)) {
      const nested: Record<string, unknown> = { ...base };
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (nestedValue === undefined) delete nested[nestedKey];
        else nested[nestedKey] = nestedValue;
      }
      merged[key] = nested;
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

export function formatIssue(issue: { path: string; message: string }): string {
  return `${issue.path}: ${issue.message}`;
}

export function parseJsonObject(path: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(text));
  } catch (error) {
    throw new NekConfigParseError(path, error instanceof Error ? error.message : String(error));
  }
  if (!isPlainObject(parsed))
    throw new NekConfigParseError(path, "expected a JSON object at the top level");
  return parsed;
}

/** `---` 分隔的 frontmatter；缺失 frontmatter 视为错误（agents/*.md 必须有 name/description）。 */
export function parseFrontmatterDocument(
  path: string,
  text: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = stripBom(text);
  if (!normalized.startsWith("---"))
    throw new NekConfigParseError(path, 'missing "---" frontmatter block');
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) throw new NekConfigParseError(path, "unterminated frontmatter block");
  const header = normalized.slice(3, end);
  const body = normalized.slice(end + 4).replace(/^\r?\n/u, "");
  let parsed: unknown;
  try {
    parsed = parseYaml(header);
  } catch (error) {
    throw new NekConfigParseError(path, error instanceof Error ? error.message : String(error));
  }
  if (!isPlainObject(parsed)) throw new NekConfigParseError(path, "frontmatter must be a mapping");
  return { frontmatter: parsed, body };
}

/** 与 nek 的 agent 文件格式一致：frontmatter + 空行 + 正文。 */
export function serializeFrontmatterDocument(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  const header = stringifyYaml(frontmatter).trimEnd();
  const trimmedBody = body.replace(/^\r?\n/u, "");
  return trimmedBody === ""
    ? `---\n${header}\n---\n`
    : `---\n${header}\n---\n\n${trimmedBody.replace(/\r?\n?$/u, "\n")}`;
}

export { NekConfigParseError };
