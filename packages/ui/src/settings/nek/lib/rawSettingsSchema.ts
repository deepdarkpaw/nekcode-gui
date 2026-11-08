/**
 * 原始 JSON 编辑的保存前校验：只校验 GUI 认识的键的类型；未知键原样保留。
 * 最终校验以后端（zod 镜像 nek TypeBox schema）为准，失败时以 `validation` 错误返回。
 */
import { z } from "zod";
import { NEK_THINKING_LEVELS, NEK_WEB_SEARCH_PROVIDERS } from "@zcode/shared/nek-protocol";

const thinkingLevel = z.enum(NEK_THINKING_LEVELS as [string, ...string[]]);
const positiveInt = z.number().int().nonnegative();
const queueMode = z.enum(["all", "one-at-a-time"]);

const settingsSchema = z
  .object({
    defaultProvider: z.string(),
    defaultModel: z.string(),
    defaultThinkingLevel: thinkingLevel,
    modelThinkingLevels: z.record(z.string(), thinkingLevel),
    enabledModels: z.array(z.string()),
    defaultTools: z.array(z.string()),
    shellPath: z.string(),
    shellCommandPrefix: z.string(),
    compaction: z
      .object({
        enabled: z.boolean(),
        reserveTokens: positiveInt,
        keepRecentTokens: positiveInt,
        model: z.string(),
        thinkingLevel: thinkingLevel,
        content: z
          .object({
            thinkingMaxChars: positiveInt,
            thinkingTotalMaxChars: positiveInt,
            toolResultMaxChars: positiveInt,
            toolErrorMaxChars: positiveInt,
            toolArgumentMaxChars: positiveInt,
            pruneToolResults: z.boolean(),
            protectedRecentTokens: positiveInt,
            protectedToolResults: positiveInt,
          })
          .partial()
          .loose(),
        modelOverrides: z.record(
          z.string(),
          z.object({ reserveTokens: positiveInt, keepRecentTokens: positiveInt }).partial(),
        ),
      })
      .partial()
      .loose(),
    branchSummary: z
      .object({ reserveTokens: positiveInt, skipPrompt: z.boolean() })
      .partial()
      .loose(),
    retry: z
      .object({
        enabled: z.boolean(),
        maxRetries: positiveInt,
        baseDelayMs: positiveInt,
        maxAgentDelayMs: positiveInt,
        provider: z
          .object({ timeoutMs: positiveInt, maxRetries: positiveInt, maxRetryDelayMs: positiveInt })
          .partial()
          .loose(),
      })
      .partial()
      .loose(),
    webSearch: z
      .object({ provider: z.enum(NEK_WEB_SEARCH_PROVIDERS), endpoint: z.string(), apiKey: z.string(), numResults: z.number().int().min(1).max(20) })
      .partial()
      .loose()
      .superRefine((web, context) => {
        if (web.provider === undefined && (web.apiKey !== undefined || web.endpoint !== undefined)) {
          context.addIssue({ code: "custom", path: ["provider"], message: "Select tavily or exa explicitly before configuring a key or endpoint" });
        }
      }),
    httpProxy: z.string(),
    httpIdleTimeoutMs: positiveInt,
    transport: z.enum(["sse", "websocket", "websocket-cached", "auto"]),
    steeringMode: queueMode,
    followUpMode: queueMode,
    defaultProjectTrust: z.enum(["ask", "always", "never"]),
    hideThinkingBlock: z.boolean(),
    updateChannel: z.enum(["stable", "dev"]),
  })
  .partial()
  .loose();

export type RawSettingsValidation =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; kind: "syntax"; message: string }
  | { ok: false; kind: "schema"; issues: Array<{ path: string; message: string }> };

export function validateRawSettings(text: string): RawSettingsValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      kind: "syntax",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, kind: "schema", issues: [{ path: "", message: "Expected a JSON object" }] };
  }
  const result = settingsSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      kind: "schema",
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}
