/**
 * 服务商表单编辑态：读取视图 ↔ 草稿 ↔ 写入值，以及校验。
 */
import type {
  NekEndpointApi,
  NekProviderDraft,
  NekProviderView,
  NekProviderWrite,
} from "@zcode/shared/nek-protocol";
import { NEK_ENDPOINT_APIS } from "@zcode/shared/nek-protocol";
import {
  apiKeyDraftFromView,
  apiKeyForDraftRequest,
  apiKeyWriteFromDraft,
  validateApiKeyDraft,
  type ApiKeyDraft,
} from "../../lib/apiKey.js";
import { analyzeBaseUrl } from "../../lib/baseUrl.js";
import {
  recordFromRows,
  rowsFromRecord,
  duplicateKeyRowIds,
  type KeyValueRow,
} from "../../lib/keyValue.js";
import { slugifyProviderId, validateProviderId } from "../../lib/providerId.js";

/** chat completions 的思考参数格式（compat.thinkingFormat）。 */
export const THINKING_FORMATS = ["openai", "zai", "qwen"] as const;

export interface ProviderDraft {
  name: string;
  id: string;
  /** 用户手动改过 ID 后不再跟随名称。 */
  idTouched: boolean;
  api: NekEndpointApi;
  baseUrl: string;
  apiKey: ApiKeyDraft;
  headers: KeyValueRow[];
  authHeader: boolean;
  thinkingFormat: string;
  /** 其余 compat 选项（JSON 对象）。 */
  compatJson: string;
}

export type ProviderDraftField = "name" | "id" | "baseUrl" | "apiKey" | "headers" | "compatJson";
export type ProviderDraftErrors = Partial<Record<ProviderDraftField, string>>;

function isEndpointApi(value: string): value is NekEndpointApi {
  return (NEK_ENDPOINT_APIS as readonly string[]).includes(value);
}

export function emptyProviderDraft(): ProviderDraft {
  return {
    name: "",
    id: "",
    idTouched: false,
    api: "openai-completions",
    baseUrl: "",
    apiKey: { mode: "literal", value: "", keepExisting: false, remove: false },
    headers: [],
    authHeader: false,
    thinkingFormat: "",
    compatJson: "",
  };
}

export function providerDraftFromView(view: NekProviderView): ProviderDraft {
  const { thinkingFormat, ...compatRest } = view.compat ?? {};
  return {
    name: view.name ?? view.id,
    id: view.id,
    idTouched: true,
    api: isEndpointApi(view.api) ? view.api : "openai-completions",
    baseUrl: view.baseUrl,
    apiKey: apiKeyDraftFromView(view.apiKey),
    headers: rowsFromRecord(view.headers),
    authHeader: view.authHeader === true,
    thinkingFormat: typeof thinkingFormat === "string" ? thinkingFormat : "",
    compatJson: Object.keys(compatRest).length > 0 ? JSON.stringify(compatRest, null, 2) : "",
  };
}

/** 名称变化时，未手动改过的 ID 跟随生成。 */
export function withName(draft: ProviderDraft, name: string): ProviderDraft {
  return { ...draft, name, id: draft.idTouched ? draft.id : slugifyProviderId(name) };
}

function parseCompat(text: string): Record<string, unknown> | null | "invalid" {
  if (text.trim() === "") {
    return null;
  }
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : "invalid";
  } catch {
    return "invalid";
  }
}

type Translate = (id: string, values?: Record<string, string | number>) => string;

export function validateProviderDraft(
  draft: ProviderDraft,
  options: { isNew: boolean; existingIds: ReadonlySet<string> },
  t: Translate,
): ProviderDraftErrors {
  const errors: ProviderDraftErrors = {};
  if (draft.name.trim() === "") {
    errors.name = t("settings.nek.provider.error.nameRequired");
  }
  if (options.isNew) {
    const idError = validateProviderId(draft.id, options.existingIds);
    if (idError) {
      errors.id = t(`settings.nek.provider.error.id.${idError}`);
    }
  }
  const baseUrl = analyzeBaseUrl(draft.api, draft.baseUrl);
  if (baseUrl.kind === "empty") {
    errors.baseUrl = t("settings.nek.provider.error.baseUrlRequired");
  } else if (baseUrl.kind === "invalid") {
    errors.baseUrl = t("settings.nek.provider.error.baseUrlInvalid");
  }
  if (validateApiKeyDraft(draft.apiKey)) {
    errors.apiKey = t("settings.nek.provider.error.envName");
  }
  if (duplicateKeyRowIds(draft.headers).size > 0) {
    errors.headers = t("settings.nek.kv.duplicate");
  }
  if (parseCompat(draft.compatJson) === "invalid") {
    errors.compatJson = t("settings.nek.provider.error.compatJson");
  }
  return errors;
}

function compatFromDraft(draft: ProviderDraft): Record<string, unknown> | undefined {
  const rest = parseCompat(draft.compatJson);
  const compat = {
    ...(rest && rest !== "invalid" ? rest : {}),
    ...(draft.thinkingFormat ? { thinkingFormat: draft.thinkingFormat } : {}),
  };
  return Object.keys(compat).length > 0 ? compat : undefined;
}

/** 草稿 → 写入值；保留原有模型与未识别字段。 */
export function providerWriteFromDraft(
  draft: ProviderDraft,
  previous?: NekProviderView,
): NekProviderWrite {
  const write: NekProviderWrite = {
    id: draft.id,
    name: draft.name.trim(),
    api: draft.api,
    baseUrl: draft.baseUrl.trim(),
    apiKey: apiKeyWriteFromDraft(draft.apiKey),
    headers: recordFromRows(draft.headers),
    authHeader: draft.authHeader ? true : undefined,
    compat: compatFromDraft(draft),
    models: previous?.models ?? [],
    extra: previous?.extra,
  };
  return Object.fromEntries(
    Object.entries(write).filter(([, value]) => value !== undefined),
  ) as NekProviderWrite;
}

/** 测试连接 / 拉取模型用的草稿配置。 */
export function requestDraftFromDraft(draft: ProviderDraft): NekProviderDraft {
  return {
    api: draft.api,
    baseUrl: draft.baseUrl.trim(),
    apiKey: apiKeyForDraftRequest(draft.apiKey),
    headers: recordFromRows(draft.headers),
    authHeader: draft.authHeader || undefined,
  };
}

/** 草稿是否与初始状态不同（用于关闭前确认）。 */
export function isProviderDraftDirty(draft: ProviderDraft, initial: ProviderDraft): boolean {
  const strip = (value: ProviderDraft) => ({
    ...value,
    headers: value.headers.map((row) => [row.key, row.value]),
  });
  return JSON.stringify(strip(draft)) !== JSON.stringify(strip(initial));
}
