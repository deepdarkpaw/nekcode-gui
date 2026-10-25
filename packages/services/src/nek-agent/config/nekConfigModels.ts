import { applyEdits, modify, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import type { NekConfigFs, NekConfigRevision } from "./nekConfigFs.js";
import {
  assertRevision,
  atomicWrite,
  NekConfigParseError,
  readSnapshot,
  revisionOf,
} from "./nekConfigFs.js";
import type { NekConfigDocument } from "./nekConfigService.js";
import {
  parseWithSchema,
  nekModelDefinitionSchema,
  nekModelsFileSchema,
  nekProviderSchema,
} from "./schemas.js";
import type { NekModelDefinition, NekModelsFile, NekProviderConfig } from "./schemas.js";

/**
 * `models.json` 的读写与高层操作。
 *
 * GUI 是 models.json 的唯一写入方（nek 只读），所以这里不做锁，但保留三层保护：
 * 1. zod 校验（与 nek 的 TypeBox schema 同约束）；
 * 2. `.tmp` + rename 原子替换；
 * 3. 乐观并发 revision（读完到写之间被外部改过就拒绝）。
 *
 * 注释：models.json 允许 `//` 注释（nek 用 `stripJsonComments` 读取）。逐条编辑走 `jsonc-parser`
 * 的文本编辑，**保留全部注释与缩进**；整份重写（`writeModels`）与模型排序（`reorderModels`）
 * 会重排该数组内的文本，数组内部注释无法保留（见报告）。
 */

const FORMATTING = { insertSpaces: true, tabSize: 2, eol: "\n" } as const;

export type NekModelsDocument = NekConfigDocument<NekModelsFile>;

function parseModelsText(path: string, text: string): NekModelsFile {
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0];
    throw new NekConfigParseError(path, first ? printParseErrorCode(first.error) : "invalid JSON");
  }
  const validated = parseWithSchema(nekModelsFileSchema, parsed ?? { providers: {} });
  if (!validated.ok) {
    throw new NekConfigParseError(
      path,
      validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    );
  }
  return validated.data;
}

/** 读 models.json（容忍注释与尾逗号）。 */
export async function readModels(fs: NekConfigFs, path: string): Promise<NekModelsDocument> {
  const snapshot = await readSnapshot(fs, path);
  if (!snapshot) return { path, data: { providers: {} }, revision: null, raw: null };
  return {
    path,
    data: parseModelsText(path, snapshot.content),
    revision: revisionOf(snapshot),
    raw: snapshot.content,
  };
}

/** 整份重写（注释丢失；逐条编辑请用下面的 granular 操作）。 */
export async function writeModels(
  fs: NekConfigFs,
  path: string,
  data: NekModelsFile,
  expected?: NekConfigRevision | null,
): Promise<NekModelsDocument> {
  const validated = parseWithSchema(nekModelsFileSchema, data);
  if (!validated.ok) {
    throw new Error(
      `invalid models.json: ${validated.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
    );
  }
  await assertRevision(fs, path, expected);
  await atomicWrite(fs, path, `${JSON.stringify(validated.data, null, 2)}\n`);
  return await readModels(fs, path);
}

/** 基于原文做一次 jsonc 文本编辑（保留注释）。 */
async function editModels(
  fs: NekConfigFs,
  path: string,
  expected: NekConfigRevision | null | undefined,
  edits: Array<{ pointer: Array<string | number>; value: unknown }>,
): Promise<NekModelsDocument> {
  const snapshot = await assertRevision(fs, path, expected);
  const base = snapshot?.content ?? '{\n  "providers": {}\n}\n';
  // 编辑前必须保证原文能被解析：否则"保留注释的编辑"会把坏文件改得半对半错。
  parseModelsText(path, base);
  let text = base;
  for (const edit of edits) {
    text = applyEdits(
      text,
      modify(text, edit.pointer, edit.value, { formattingOptions: FORMATTING }),
    );
  }
  // 编辑后的结果必须仍然合法：宁可报错，也不落一个 nek 读不了的文件。
  parseModelsText(path, text);
  await atomicWrite(fs, path, text);
  return await readModels(fs, path);
}

export async function upsertProvider(
  fs: NekConfigFs,
  path: string,
  providerId: string,
  provider: NekProviderConfig,
  expected?: NekConfigRevision | null,
): Promise<NekModelsDocument> {
  if (providerId.trim() === "") throw new Error("provider id must not be empty");
  const validated = parseWithSchema(nekProviderSchema, provider);
  if (!validated.ok) {
    throw new Error(
      `invalid provider "${providerId}": ${validated.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  }
  return await editModels(fs, path, expected, [
    { pointer: ["providers", providerId], value: validated.data },
  ]);
}

export async function removeProvider(
  fs: NekConfigFs,
  path: string,
  providerId: string,
  expected?: NekConfigRevision | null,
): Promise<NekModelsDocument> {
  return await editModels(fs, path, expected, [
    { pointer: ["providers", providerId], value: undefined },
  ]);
}

export async function upsertModel(
  fs: NekConfigFs,
  path: string,
  providerId: string,
  model: NekModelDefinition,
  expected?: NekConfigRevision | null,
): Promise<NekModelsDocument> {
  const validated = parseWithSchema(nekModelDefinitionSchema, model);
  if (!validated.ok) {
    throw new Error(
      `invalid model "${model.id}": ${validated.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    );
  }
  const current = await readModels(fs, path);
  const provider = current.data.providers[providerId];
  if (!provider) throw new Error(`provider "${providerId}" is not configured in ${path}`);
  const models = [...(provider.models ?? [])];
  const index = models.findIndex((entry) => entry.id === validated.data.id);
  if (index === -1) models.push(validated.data);
  else models[index] = validated.data;
  return await editModels(fs, path, expected, [
    { pointer: ["providers", providerId, "models"], value: models },
  ]);
}

export async function removeModel(
  fs: NekConfigFs,
  path: string,
  providerId: string,
  modelId: string,
  expected?: NekConfigRevision | null,
): Promise<NekModelsDocument> {
  const current = await readModels(fs, path);
  const provider = current.data.providers[providerId];
  if (!provider) return current;
  const models = (provider.models ?? []).filter((entry) => entry.id !== modelId);
  return await editModels(fs, path, expected, [
    { pointer: ["providers", providerId, "models"], value: models },
  ]);
}

/** 按给定顺序重排某个服务商的 models 数组；未列出的模型按原顺序追加在后面。 */
export async function reorderModels(
  fs: NekConfigFs,
  path: string,
  providerId: string,
  orderedIds: readonly string[],
  expected?: NekConfigRevision | null,
): Promise<NekModelsDocument> {
  const current = await readModels(fs, path);
  const provider = current.data.providers[providerId];
  if (!provider) throw new Error(`provider "${providerId}" is not configured in ${path}`);
  const existing = provider.models ?? [];
  const byId = new Map(existing.map((model) => [model.id, model]));
  const ordered: NekModelDefinition[] = [];
  for (const id of orderedIds) {
    const model = byId.get(id);
    if (!model) throw new Error(`model "${id}" is not configured for provider "${providerId}"`);
    ordered.push(model);
    byId.delete(id);
  }
  for (const model of existing) if (byId.has(model.id)) ordered.push(model);
  return await editModels(fs, path, expected, [
    { pointer: ["providers", providerId, "models"], value: ordered },
  ]);
}
