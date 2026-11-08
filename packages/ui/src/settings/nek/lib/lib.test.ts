import { describe, expect, it } from "vitest";
import { analyzeBaseUrl, finalRequestUrl } from "./baseUrl.js";
import { formatTokenCountDraft, parseTokenCount } from "./tokenCount.js";
import { slugifyProviderId, validateProviderId } from "./providerId.js";
import {
  apiKeyDraftFromView,
  apiKeyForDraftRequest,
  apiKeyWriteFromDraft,
  normalizeEnvName,
  sanitizePastedApiKey,
  validateApiKeyDraft,
} from "./apiKey.js";
import { buildDefaultToolsSetting, resolveEnabledTools } from "./defaultTools.js";
import { parseModelRef, supportedThinkingLevels } from "./modelRef.js";
import { thinkingDraftFromModel, thinkingFieldsFromDraft } from "./thinkingLevels.js";
import { classifyFetchError, mergeFetchedModels, modelConfigFromRow } from "./fetchedModels.js";
import { applySettingsPatch, diffSettingsValues, rawDiffToSettingsPatch } from "./settingsPatch.js";
import { validateRawSettings } from "./rawSettingsSchema.js";
import {
  emptyMcpDraft,
  mcpConfigFromDraft,
  mcpDraftFromConfig,
  suggestUniqueName,
  validateMcpDraft,
} from "./mcpForm.js";
import { checkCompaction } from "./compactionChecks.js";
import { recordActionBinding } from "./actionRecording.js";
import type { NekCatalogModel } from "@zcode/shared/nek-protocol";

describe("baseUrl", () => {
  it("previews the final request URL per endpoint type", () => {
    expect(finalRequestUrl("openai-completions", "https://x/v1")).toBe(
      "https://x/v1/chat/completions",
    );
    expect(finalRequestUrl("anthropic-messages", "https://api.anthropic.com")).toBe(
      "https://api.anthropic.com/v1/messages",
    );
  });

  it("detects a pasted endpoint suffix and offers the fix", () => {
    const analysis = analyzeBaseUrl("openai-completions", "https://api.x.com/v1/chat/completions");
    expect(analysis).toMatchObject({
      kind: "ok",
      issue: { kind: "endpointSuffix", fixed: "https://api.x.com/v1" },
    });
  });

  it("detects a missing /v1 and a duplicated /v1 for Anthropic", () => {
    expect(analyzeBaseUrl("openai-responses", "https://api.x.com")).toMatchObject({
      issue: { kind: "missingVersion", fixed: "https://api.x.com/v1" },
    });
    expect(analyzeBaseUrl("anthropic-messages", "https://proxy.example.com/v1")).toMatchObject({
      issue: { kind: "duplicateVersion", fixed: "https://proxy.example.com" },
    });
  });

  it("rejects non-http URLs and accepts clean ones", () => {
    expect(analyzeBaseUrl("openai-completions", "ftp://x")).toEqual({ kind: "invalid" });
    expect(analyzeBaseUrl("openai-completions", "")).toEqual({ kind: "empty" });
    expect(analyzeBaseUrl("openai-completions", "https://api.x.com/v1")).toMatchObject({
      issue: null,
    });
    expect(analyzeBaseUrl("openai-completions", "https://api.x.com/v1/")).toMatchObject({
      issue: { kind: "trailingSlash" },
    });
  });
});

describe("tokenCount", () => {
  it("parses k / M shorthands with 1k = 1000", () => {
    expect(parseTokenCount("200k")).toBe(200_000);
    expect(parseTokenCount("1M")).toBe(1_000_000);
    expect(parseTokenCount("1.5k")).toBe(1500);
    expect(parseTokenCount("128,000")).toBe(128_000);
    expect(parseTokenCount("abc")).toBeNull();
    expect(parseTokenCount("0")).toBeNull();
  });

  it("formats drafts compactly", () => {
    expect(formatTokenCountDraft(200_000)).toBe("200k");
    expect(formatTokenCountDraft(1_000_000)).toBe("1M");
    expect(formatTokenCountDraft(16_384)).toBe("16384");
  });
});

describe("providerId", () => {
  it("slugifies names and validates", () => {
    expect(slugifyProviderId("My Proxy (EU)")).toBe("my-proxy-eu");
    expect(slugifyProviderId("深度求索")).toBe("");
    expect(validateProviderId("", new Set())).toBe("required");
    expect(validateProviderId("Bad_ID", new Set())).toBe("format");
    expect(validateProviderId("deepseek", new Set(["deepseek"]))).toBe("duplicate");
    expect(validateProviderId("ok-1", new Set())).toBeNull();
  });
});

describe("apiKey", () => {
  it("strips whitespace from pasted keys", () => {
    expect(sanitizePastedApiKey(" sk-abc\n123 ")).toBe("sk-abc123");
  });

  it("keeps the existing literal key unless changed", () => {
    const draft = apiKeyDraftFromView({ kind: "literal", masked: "••••1234" });
    expect(apiKeyWriteFromDraft(draft)).toEqual({ keep: true });
    expect(apiKeyWriteFromDraft({ ...draft, value: "sk-new" })).toBe("sk-new");
  });

  it("writes env variables as $NAME and validates names", () => {
    expect(normalizeEnvName("${OPENAI_KEY}")).toBe("OPENAI_KEY");
    expect(
      apiKeyWriteFromDraft({
        mode: "env",
        value: "$OPENAI_KEY",
        keepExisting: false,
        remove: false,
      }),
    ).toBe("$OPENAI_KEY");
    expect(
      validateApiKeyDraft({ mode: "env", value: "1BAD", keepExisting: false, remove: false }),
    ).toBe("envName");
  });

  it("never writes an empty string and removes only on an explicit remove", () => {
    const existing = apiKeyDraftFromView({ kind: "literal", masked: "••••1234" });
    // 显式"清除密钥"
    expect(apiKeyWriteFromDraft({ ...existing, remove: true })).toEqual({ remove: true });
    // 清空输入框 = 删除（不是"保持"），更不是空串
    expect(apiKeyWriteFromDraft({ ...existing, keepExisting: false })).toEqual({ remove: true });
    expect(
      apiKeyWriteFromDraft({ mode: "env", value: "", keepExisting: false, remove: false }),
    ).toEqual({ remove: true });
    expect(
      apiKeyWriteFromDraft({ mode: "command", value: "  ", keepExisting: false, remove: false }),
    ).toEqual({ remove: true });
    // 草稿请求里 keep / remove 都退回已保存的密钥
    expect(apiKeyForDraftRequest({ ...existing, remove: true })).toBeUndefined();
  });
});

describe("defaultTools", () => {
  const defaults = ["read", "bash", "web_search"];

  it("resolves +/- deltas against defaults", () => {
    expect([...resolveEnabledTools(["-web_search", "+grep"], defaults)]).toEqual([
      "read",
      "bash",
      "grep",
    ]);
    expect([...resolveEnabledTools(undefined, defaults)]).toEqual(defaults);
    expect([...resolveEnabledTools(["read"], defaults)]).toEqual(["read"]);
  });

  it("writes deltas and null when equal to defaults", () => {
    const known = ["read", "bash", "grep", "web_search"];
    expect(buildDefaultToolsSetting(new Set(["read", "bash"]), defaults, known)).toEqual([
      "-web_search",
    ]);
    expect(buildDefaultToolsSetting(new Set(defaults), defaults, known)).toBeNull();
    expect(buildDefaultToolsSetting(new Set([...defaults, "grep"]), defaults, known)).toEqual([
      "+grep",
    ]);
  });
});

describe("modelRef", () => {
  it("splits on the first slash only", () => {
    expect(parseModelRef("openrouter/anthropic/claude")).toEqual({
      provider: "openrouter",
      id: "anthropic/claude",
    });
    expect(parseModelRef("nope")).toBeNull();
  });

  it("lists supported thinking levels", () => {
    const model = { reasoning: true, thinkingLevels: ["high", "off"] } as NekCatalogModel;
    expect(supportedThinkingLevels(model)).toEqual(["off", "high"]);
    expect(
      supportedThinkingLevels({
        reasoning: false,
        thinkingLevels: [],
      } as unknown as NekCatalogModel),
    ).toEqual(["off"]);
  });
});

describe("thinkingLevels", () => {
  it("round-trips the level map with raw upstream values", () => {
    const draft = thinkingDraftFromModel({
      reasoning: true,
      thinkingLevelMap: { max: null, high: "32000" },
    });
    expect(draft.enabled.has("max")).toBe(false);
    expect(draft.raw.high).toBe("32000");
    expect(thinkingFieldsFromDraft(draft)).toEqual({
      reasoning: true,
      thinkingLevelMap: { high: "32000", max: null },
    });
  });

  it("omits the map when everything uses defaults", () => {
    const draft = thinkingDraftFromModel({ reasoning: true });
    expect(thinkingFieldsFromDraft(draft)).toEqual({
      reasoning: true,
      thinkingLevelMap: undefined,
    });
  });
});

describe("fetchedModels", () => {
  const catalog = [
    {
      provider: "x",
      api: "openai-responses",
      id: "gpt-4.1",
      name: "GPT-4.1",
      contextWindow: 1_000_000,
      maxTokens: 32_000,
      reasoning: false,
      thinkingLevels: [],
      input: ["text"],
    },
  ] as NekCatalogModel[];

  it("orders metadata sources: api > catalog > default", () => {
    const rows = mergeFetchedModels(
      [{ id: "a", contextWindow: 50_000 }, { id: "gpt-4.1" }, { id: "custom" }, { id: "a" }],
      catalog,
      new Set(["custom"]),
    );
    expect(rows.map((row) => [row.id, row.source, row.alreadyAdded])).toEqual([
      ["a", "api", false],
      ["gpt-4.1", "catalog", false],
      ["custom", "default", true],
    ]);
    expect(rows[2]).toMatchObject({ contextWindow: 128_000, maxTokens: 16_384 });
  });

  it("converts rows to model configs with unsupported levels as null", () => {
    const [row] = mergeFetchedModels(
      [{ id: "r", reasoning: true, thinkingLevels: ["off", "high"] }],
      [],
      new Set(),
    );
    expect(modelConfigFromRow(row!).thinkingLevelMap).toMatchObject({ minimal: null, max: null });
  });

  it("classifies 401/403/404", () => {
    expect(classifyFetchError({ ok: false, endpoint: "", status: 403, message: "" })).toBe("auth");
    expect(classifyFetchError({ ok: false, endpoint: "", status: 404, message: "" })).toBe(
      "notFound",
    );
    expect(classifyFetchError({ ok: false, endpoint: "", message: "" })).toBe("other");
  });
});

describe("settingsPatch", () => {
  it("merges nested keys and deletes on null", () => {
    const view = { compaction: { enabled: true, model: "a/b" }, httpProxy: "x" };
    expect(applySettingsPatch(view, { compaction: { reserveTokens: 1 }, httpProxy: null })).toEqual(
      {
        compaction: { enabled: true, model: "a/b", reserveTokens: 1 },
      },
    );
  });

  it("diffs raw JSON into a minimal patch with unknown keys in extra", () => {
    const diff = diffSettingsValues(
      { compaction: { enabled: true, model: "a/b" }, theme: "dark", keep: 1 },
      { compaction: { enabled: false }, keep: 1, newKey: [1] },
    );
    expect(diff).toEqual({ compaction: { enabled: false, model: null }, theme: null, newKey: [1] });
    expect(rawDiffToSettingsPatch(diff)).toEqual({
      compaction: { enabled: false, model: null },
      extra: { theme: null, newKey: [1] },
    });
  });
});

describe("rawSettingsSchema", () => {
  it("matches nek web-search providers and result bounds", () => {
    for (const webSearch of [
      { provider: "tavily", apiKey: "$TAVILY_API_KEY", numResults: 20 },
      { provider: "exa", numResults: 1 },
      {},
    ]) {
      expect(validateRawSettings(JSON.stringify({ webSearch }))).toMatchObject({ ok: true });
    }
    for (const webSearch of [
      { provider: "unknown" },
      { provider: "brave", numResults: 8 },
      { numResults: 0 },
      { numResults: 21 },
      { numResults: 1.5 },
      { apiKey: 42 },
      // nek 要求 apiKey/endpoint 存在时 trim() 后非空：空串和纯空白都不能落盘。
      { provider: "tavily", apiKey: "" },
      { provider: "tavily", apiKey: "   " },
      { provider: "exa", endpoint: "" },
      { provider: "exa", endpoint: "  " },
    ]) {
      expect(validateRawSettings(JSON.stringify({ webSearch }))).toMatchObject({
        ok: false,
        kind: "schema",
      });
    }
  });

  it("keeps the key verbatim instead of trimming it", () => {
    const apiKey = "  $PROJECT_SEARCH_KEY  ";
    const result = validateRawSettings(JSON.stringify({ webSearch: { provider: "exa", apiKey } }));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("expected the raw settings to validate");
    // 校验只判空，不改写内容：密钥原样交给后端。
    expect((result.value.webSearch as { apiKey: string }).apiKey).toBe(apiKey);
  });

  it("leaves the provider/credential pairing to the merge-time check", () => {
    // 单个作用域的文件看不到另一个作用域的 provider：项目只写 key、全局写 provider 是合法的，
    // 所以这里不能拒绝；"有 key 就必须有 provider" 由后端在合并后判定。
    for (const webSearch of [
      { apiKey: "$PROJECT_SEARCH_KEY" },
      { endpoint: "https://mcp.exa.ai/mcp" },
    ]) {
      expect(validateRawSettings(JSON.stringify({ webSearch }))).toMatchObject({ ok: true });
    }
  });

  it("reports syntax and schema errors", () => {
    expect(validateRawSettings("{")).toMatchObject({ ok: false, kind: "syntax" });
    expect(validateRawSettings('{"transport":"carrier-pigeon"}')).toMatchObject({
      ok: false,
      kind: "schema",
    });
    expect(validateRawSettings('{"transport":"sse","unknown":1}')).toMatchObject({ ok: true });
  });
});

describe("mcpForm", () => {
  const t = (id: string) => id;

  it("validates required fields per transport", () => {
    const errors = validateMcpDraft({ ...emptyMcpDraft(), name: "has space" }, new Set(), t);
    expect(errors).toMatchObject({
      name: "settings.nek.mcp.form.error.nameFormat",
      command: expect.any(String),
    });
    const http = validateMcpDraft(
      { ...emptyMcpDraft(), name: "x", transport: "http", url: "nope" },
      new Set(),
      t,
    );
    expect(http.url).toBeDefined();
  });

  it("round-trips configs and omits empty optionals", () => {
    const config = { command: "npx", args: ["-y", "pkg"], env: { A: "1" }, timeout: 30 };
    expect(mcpConfigFromDraft(mcpDraftFromConfig("fs", config))).toEqual(config);
    const http = { type: "http" as const, url: "https://x/mcp", oauth: { scope: "repo" } };
    expect(mcpConfigFromDraft(mcpDraftFromConfig("gh", http))).toEqual(http);
  });

  it("suggests unique names for conflicts", () => {
    expect(suggestUniqueName("fs", new Set(["fs", "fs-2"]))).toBe("fs-3");
  });
});

describe("compactionChecks", () => {
  const models = [
    {
      provider: "a",
      id: "big",
      contextWindow: 200_000,
      reasoning: true,
      thinkingLevels: ["off", "high"],
    },
    { provider: "a", id: "small", contextWindow: 8_000, reasoning: false, thinkingLevels: [] },
  ] as unknown as NekCatalogModel[];
  const base = { defaultProvider: "a", defaultModel: "big" };

  it("flags missing models, unsupported levels and small contexts", () => {
    const kinds = (settings: object) =>
      checkCompaction({ ...base, ...settings }, models, {
        compaction: { reserveTokens: 16_384 },
      }).map((issue) => issue.kind);
    expect(kinds({ compaction: { model: "a/gone" } })).toEqual(["modelMissing"]);
    expect(kinds({ compaction: { thinkingLevel: "medium" } })).toEqual(["thinkingUnsupported"]);
    expect(kinds({ compaction: { model: "a/small" } })).toEqual([
      "reserveExceedsContext",
      "smallerContext",
    ]);
    expect(kinds({})).toEqual([]);
  });
});

describe("actionRecording", () => {
  const event = (
    key: string,
    mods: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {},
  ) => ({
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });
  const win = { platform: "Win32", userAgent: "Windows" };

  it("records extended keys with modifiers and cancels on Escape", () => {
    expect(recordActionBinding(event("Tab", { shiftKey: true }), win)).toEqual({
      kind: "recorded",
      binding: "Shift+Tab",
    });
    expect(recordActionBinding(event("Escape"), win)).toEqual({ kind: "cancel" });
  });

  it("delegates normal keys to the core recorder", () => {
    expect(recordActionBinding({ ...event("k", { ctrlKey: true }), code: "KeyK" }, win)).toEqual({
      kind: "recorded",
      binding: "CmdOrCtrl+k",
    });
    expect(recordActionBinding(event("Control", { ctrlKey: true }), win)).toEqual({
      kind: "pending",
    });
  });
});
