/**
 * Base URL 校验与最终请求地址预览（设置中心 · 服务商表单）。
 *
 * 规则与 nek（pi-ai）各端点 SDK 的拼接方式一致：
 * - OpenAI 兼容：`{base}/chat/completions`；
 * - OpenAI Responses：`{base}/responses`；
 * - Anthropic Messages：SDK 自带 `/v1/messages`，base 不应包含 `/v1`；
 * - Google Gemini：`{base}/models/{model}:streamGenerateContent`，base 一般以 `/v1beta` 结尾。
 */
import type { NekEndpointApi } from "@zcode/shared/nek-protocol";

export const BASE_URL_PLACEHOLDERS: Readonly<Record<NekEndpointApi, string>> = {
  "openai-completions": "https://api.openai.com/v1",
  "openai-responses": "https://api.openai.com/v1",
  "anthropic-messages": "https://api.anthropic.com",
  "google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
};

/** 常见错误：每种都附带一键修正后的地址。 */
type BaseUrlIssue =
  | { kind: "endpointSuffix"; suffix: string; fixed: string }
  | { kind: "duplicateVersion"; suffix: string; fixed: string }
  | { kind: "missingVersion"; version: string; fixed: string }
  | { kind: "trailingSlash"; fixed: string };

export type BaseUrlAnalysis =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "ok"; finalUrl: string; issue: BaseUrlIssue | null };

const ENDPOINT_SUFFIXES: Readonly<Record<NekEndpointApi, readonly string[]>> = {
  "openai-completions": ["/chat/completions", "/completions"],
  "openai-responses": ["/responses"],
  "anthropic-messages": ["/v1/messages", "/messages"],
  "google-generative-ai": ["/models"],
};

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** 最终请求地址；base 需已去掉末尾斜杠。 */
export function finalRequestUrl(api: NekEndpointApi, base: string, modelId = "{model}"): string {
  switch (api) {
    case "openai-completions":
      return `${base}/chat/completions`;
    case "openai-responses":
      return `${base}/responses`;
    case "anthropic-messages":
      return `${base}/v1/messages`;
    case "google-generative-ai":
      return `${base}/models/${modelId.replace(/^models\//u, "")}:streamGenerateContent?alt=sse`;
  }
}

function detectSuffixIssue(api: NekEndpointApi, base: string): BaseUrlIssue | null {
  const lower = base.toLowerCase();
  for (const suffix of ENDPOINT_SUFFIXES[api]) {
    if (lower.endsWith(suffix)) {
      return { kind: "endpointSuffix", suffix, fixed: base.slice(0, -suffix.length) };
    }
  }
  const generate = lower.search(/\/models\/[^/]+:(stream)?generatecontent$/);
  if (api === "google-generative-ai" && generate > 0) {
    return { kind: "endpointSuffix", suffix: base.slice(generate), fixed: base.slice(0, generate) };
  }
  return null;
}

function detectVersionIssue(api: NekEndpointApi, base: string, url: URL): BaseUrlIssue | null {
  const path = stripTrailingSlashes(url.pathname);
  if (api === "anthropic-messages" && /\/v1$/i.test(path)) {
    return { kind: "duplicateVersion", suffix: "/v1", fixed: base.slice(0, -3) };
  }
  if (path !== "") {
    return null;
  }
  if (api === "openai-completions" || api === "openai-responses") {
    return { kind: "missingVersion", version: "/v1", fixed: `${base}/v1` };
  }
  if (api === "google-generative-ai") {
    return { kind: "missingVersion", version: "/v1beta", fixed: `${base}/v1beta` };
  }
  return null;
}

/** 分析输入的 Base URL：最终地址 + 第一个常见错误（含修正值）。 */
export function analyzeBaseUrl(
  api: NekEndpointApi,
  raw: string,
  modelId?: string,
): BaseUrlAnalysis {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { kind: "empty" };
  }
  const url = parseHttpUrl(trimmed);
  if (!url) {
    return { kind: "invalid" };
  }
  const base = stripTrailingSlashes(trimmed);
  const issue =
    detectSuffixIssue(api, base) ??
    detectVersionIssue(api, base, url) ??
    (base !== trimmed ? { kind: "trailingSlash" as const, fixed: base } : null);
  return { kind: "ok", finalUrl: finalRequestUrl(api, base, modelId), issue };
}
