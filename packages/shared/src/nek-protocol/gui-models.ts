import type { NekThinkingLevel } from "./gui-rpc.js";

/** `get_model_scope` 的一条解析结果。 */
export interface NekModelScopeEntry {
  provider: string;
  id: string;
  /** 模式里显式写了 `:level` 时才有。 */
  thinkingLevel?: NekThinkingLevel;
}

export interface NekModelScopeDiagnostic {
  code: "no-match" | "invalid-thinking-level" | "ambiguous";
  message: string;
  pattern: string;
}

/**
 * `get_model_scope`：CLI `/model` 列表与 Ctrl+P 循环使用的模型范围。
 *
 * `patterns` 是 cwd 生效设置（global ← 受信任 project 深合并）中的 `enabledModels` 原文；
 * `models` 由 nek 自己的 `resolveModelScopeFromModels` 对可用模型解析得到，顺序与 CLI 一致。
 * `patterns` 为空表示未设置范围：CLI 显示全部可用模型，此时 `models` 也为空。
 */
export interface NekModelScopeResult {
  patterns: string[];
  models: NekModelScopeEntry[];
  diagnostics: NekModelScopeDiagnostic[];
}

export interface NekCatalogModel {
  provider: string;
  id: string;
  name: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** `getSupportedThinkingLevels` 的结果。 */
  thinkingLevels: NekThinkingLevel[];
  thinkingLevelMap?: Partial<Record<NekThinkingLevel, string | null>>;
  input: Array<"text" | "image">;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface NekRemoteModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  thinkingLevels?: NekThinkingLevel[];
  input?: Array<"text" | "image">;
}

/** 失败不是 RPC 错误，而是结构化结果，便于 GUI 映射 401/403/404。 */
export type NekFetchModelsResult =
  | { ok: true; endpoint: string; models: NekRemoteModel[] }
  | { ok: false; endpoint: string; status?: number; message: string };

export type NekTestProviderResult =
  | { ok: true; latencyMs: number }
  | { ok: false; status?: number; message: string };
