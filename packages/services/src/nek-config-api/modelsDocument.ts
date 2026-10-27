/**
 * models.json 的编解码与单文件编辑。
 *
 * 三件事：
 * 1. **保留原文**：编辑走 `jsonc-parser` 的 `modify`/`applyEdits`，注释、未知字段、键顺序都不动
 *    （nek 用 `stripJsonComments` 读，用户会在里面写注释）；
 * 2. **API Key 永不回显**：字面量在读取视图里变成掩码，`$ENV`/`${ENV}`/`!cmd` 各自带出形态；
 * 3. **未知字段透传**：`extra` 把 GUI 不认识的键原样带回写入端，避免一次保存毁掉 nek 的新字段。
 */
import type {
  NekModelConfig,
  NekProviderView,
  NekProviderWrite,
} from "@zcode/shared/nek-protocol";
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";
import {
  nekModelDefinitionSchema,
  nekProviderSchema,
  parseWithSchema,
} from "../nek-agent/config/schemas.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import {
  applyJsoncEdit,
  EMPTY_MODELS_TEXT,
  parseJsoncMapping,
  readTextDocument,
  writeTextDocument,
} from "./documents.js";
import { conflict, fieldErrorsOf, validationError } from "./errors.js";
import { sameRevision } from "./revision.js";

/** nek 内置服务商的 ID（models.json 里出现同名条目即为"覆盖内置服务商"）。 */
export const BUILTIN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  "openai",
  "azure-openai-responses",
  "openai-codex",
  "radius",
  "nvidia",
  "deepseek",
  "google",
  "google-vertex",
  "github-copilot",
  "openrouter",
  "vercel-ai-gateway",
  "xai",
  "groq",
  "cerebras",
  "zai",
  "zai-coding-cn",
  "mistral",
  "minimax",
  "minimax-cn",
  "moonshotai",
  "moonshotai-cn",
  "huggingface",
  "fireworks",
  "together",
  "baseten",
  "opencode",
  "opencode-go",
  "kimi-coding",
  "meta",
  "cloudflare-workers-ai",
  "cloudflare-ai-gateway",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
]);

const PROVIDER_KNOWN_KEYS = new Set([
  "name",
  "api",
  "baseUrl",
  "apiKey",
  "headers",
  "authHeader",
  "compat",
  "models",
]);

const MODEL_KNOWN_KEYS = new Set([
  "id",
  "name",
  "contextWindow",
  "maxTokens",
  "input",
  "reasoning",
  "thinkingLevelMap",
  "cost",
  "headers",
  "compat",
]);

/** 字面量密钥的掩码：只保留末 4 位（与界面一致）。 */
export function maskApiKey(key: string): string {
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}

/** `$NAME` / `${NAME}` → 环境变量；`!cmd` → 命令；其余按字面量处理。 */
export function apiKeyView(raw: unknown): NekProviderView["apiKey"] {
  if (typeof raw !== "string" || raw === "") return { kind: "none" };
  const env = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/u.exec(raw);
  if (env) return { kind: "env", name: env[1] ?? "" };
  if (raw.startsWith("!")) return { kind: "command", command: raw.slice(1) };
  return { kind: "literal", masked: maskApiKey(raw) };
}

function pickKnown(
  raw: Record<string, unknown>,
  known: ReadonlySet<string>,
): { value: Record<string, unknown>; extra: Record<string, unknown> } {
  const value: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (known.has(key)) value[key] = entry;
    else extra[key] = entry;
  }
  return { value, extra };
}

export function modelToView(raw: Record<string, unknown>): NekModelConfig {
  const { value, extra } = pickKnown(raw, MODEL_KNOWN_KEYS);
  const model = { ...value } as unknown as NekModelConfig;
  model.id = typeof raw.id === "string" ? raw.id : "";
  if (Object.keys(extra).length > 0) model.extra = extra;
  return model;
}

export function providerToView(id: string, raw: Record<string, unknown>): NekProviderView {
  const { value, extra } = pickKnown(raw, PROVIDER_KNOWN_KEYS);
  const models = Array.isArray(raw.models)
    ? raw.models.filter(isPlainObject).map(modelToView)
    : [];
  const view: NekProviderView = {
    ...(value as unknown as Omit<NekProviderView, "apiKey" | "models" | "overridesBuiltin">),
    id,
    api: typeof raw.api === "string" ? raw.api : "",
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
    apiKey: apiKeyView(raw.apiKey),
    models,
    overridesBuiltin: BUILTIN_PROVIDER_IDS.has(id),
  };
  if (Object.keys(extra).length > 0) view.extra = extra;
  return view;
}

/** 模型视图 → 写回 models.json 的值（保留 `extra` 里的未知字段）。 */
export function modelWriteToValue(model: NekModelConfig): Record<string, unknown> {
  const { extra = {}, ...known } = model;
  const value: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(known)) {
    if (entry !== undefined && entry !== null) value[key] = entry;
  }
  return { ...value, ...extra };
}

/** API Key 的写入解析：`{keep:true}` / `undefined` 保留原值，空串表示删除。 */
function resolveApiKey(
  input: NekProviderWrite["apiKey"],
  existing: Record<string, unknown> | undefined,
): unknown {
  if (input === undefined) return existing?.apiKey;
  if (typeof input === "object" && input !== null) return existing?.apiKey;
  if (input === "") return undefined;
  return input;
}

/** 服务商视图 → 写回 models.json 的值。 */
export function providerWriteToValue(
  write: NekProviderWrite,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  const source = write as unknown as Record<string, unknown>;
  for (const [key, entry] of Object.entries(source)) {
    // `id` 是键名（不是字段），`extra` 摊平到末尾，`overridesBuiltin` 是读取视图的派生标记。
    if (key === "id" || key === "apiKey" || key === "extra" || key === "overridesBuiltin") continue;
    if (entry === undefined) continue;
    if (key === "models" && Array.isArray(entry)) {
      value.models = entry
        .filter(isPlainObject)
        .map((model) => modelWriteToValue(model as unknown as NekModelConfig));
      continue;
    }
    value[key] = entry;
  }
  // `models` 缺失时保留原文，避免"只改 baseUrl"把模型表清空。
  if (value.models === undefined && Array.isArray(existing?.models)) value.models = existing.models;
  const apiKey = resolveApiKey(write.apiKey, existing);
  if (apiKey !== undefined) value.apiKey = apiKey;
  const extra = isPlainObject(write.extra) ? write.extra : {};
  return { ...value, ...extra };
}

export interface NekJsoncEdit {
  pointer: Array<string | number>;
  value: unknown;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 服务商的写入拆成"逐字段编辑"。
 *
 * 整对象替换会让 jsonc-parser 重建该节点：provider 内部的注释与键顺序都会丢
 * （只有顶层与兄弟键的注释能活下来）。逐字段编辑把影响面压到真正改动的字段。
 */
export function providerEdits(
  providerId: string,
  existing: Record<string, unknown> | undefined,
  value: Record<string, unknown>,
): NekJsoncEdit[] {
  if (!existing) return [{ pointer: ["providers", providerId], value }];
  const edits: NekJsoncEdit[] = [];
  for (const [key, next] of Object.entries(value)) {
    if (sameJson(existing[key], next)) continue;
    edits.push({ pointer: ["providers", providerId, key], value: next });
  }
  for (const key of Object.keys(existing)) {
    if (key in value) continue;
    edits.push({ pointer: ["providers", providerId, key], value: undefined });
  }
  return edits;
}

/** 用 zod 镜像校验单个服务商 / 模型，返回字段级错误。 */
export function validateProviderValue(
  providerId: string,
  value: Record<string, unknown>,
): void {
  const validated = parseWithSchema(nekProviderSchema, value);
  if (validated.ok) return;
  const fieldErrors = fieldErrorsOf(validated.issues);
  const prefixed: Record<string, string> = {};
  for (const [path, message] of Object.entries(fieldErrors)) {
    prefixed[path === "(root)" ? `providers.${providerId}` : `providers.${providerId}.${path}`] = message;
  }
  throw validationError(`invalid provider "${providerId}"`, prefixed);
}

export function validateModelValue(providerId: string, model: NekModelConfig): void {
  const validated = parseWithSchema(nekModelDefinitionSchema, modelWriteToValue(model));
  if (validated.ok) return;
  const fieldErrors: Record<string, string> = {};
  for (const [path, message] of Object.entries(fieldErrorsOf(validated.issues))) {
    fieldErrors[`providers.${providerId}.models.${path}`] = message;
  }
  throw validationError(`invalid model "${model.id}"`, fieldErrors);
}

export interface NekModelsSnapshot {
  path: string;
  /** 原文（文件不存在时是空模板）。 */
  text: string;
  revision: string;
  /** 顶层对象（未知顶层键原样保留）。 */
  data: Record<string, unknown>;
  providers: Record<string, Record<string, unknown>>;
}

function readProviders(path: string, data: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const raw = data.providers;
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw validationError(`${path}: "providers" must be an object`, { providers: "must be an object" });
  }
  const providers: Record<string, Record<string, unknown>> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (isPlainObject(value)) providers[id] = value;
  }
  return providers;
}

export async function readModelsSnapshot(
  executor: NekConfigHostExecutor,
  path: string,
): Promise<NekModelsSnapshot> {
  const document = await readTextDocument(executor, path);
  const text = document.content ?? EMPTY_MODELS_TEXT;
  const data = parseJsoncMapping(path, text);
  return { path, text, revision: document.revision, data, providers: readProviders(path, data) };
}

/**
 * 逐条编辑后一次性原子写；返回新 revision。
 *
 * 写入前重新读一次原文并比对 revision：`models.json` 没有锁（nek 只读它），
 * 靠"写前再确认"把被外部改写的窗口压到最小。
 */
export async function editModelsSnapshot(
  executor: NekConfigHostExecutor,
  snapshot: NekModelsSnapshot,
  expectedRevision: string,
  edits: readonly NekJsoncEdit[],
): Promise<string> {
  const current = await readTextDocument(executor, snapshot.path);
  if (!sameRevision(current.revision, expectedRevision)) throw conflict(snapshot.path);
  let text = current.content ?? EMPTY_MODELS_TEXT;
  for (const edit of edits) text = applyJsoncEdit(snapshot.path, text, edit.pointer, edit.value);
  return await writeTextDocument(executor, snapshot.path, text);
}
