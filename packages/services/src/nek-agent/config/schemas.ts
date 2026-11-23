import { z } from "zod";
import { nekSettingsIssues, type NekSettingsView } from "@zcode/shared/nek-protocol";

/**
 * nek 配置文件的 zod 镜像。
 *
 * 与 nek 的 TypeBox/手写校验保持同一组约束，但有两个刻意的差别：
 * 1. 全部用 `z.looseObject`（未知字段原样保留）：GUI 只负责它编辑的那部分，其余键不能因为
 *    一次保存而消失 —— nek 会持续加字段，删掉它们等于破坏用户配置；
 * 2. 只校验 GUI 会写的字段的形状，超出能力范围的复杂字段（`compat`、`samplingParams`、
 *    `inputLimits` 等）当作不透明 JSON 透传。
 */

const loose = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);

export const NEK_THINKING_LEVEL_VALUES = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export const nekThinkingLevelSchema = z.enum(NEK_THINKING_LEVEL_VALUES);

export const NEK_ENDPOINT_API_VALUES = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;
export const nekEndpointApiSchema = z.enum(NEK_ENDPOINT_API_VALUES);

// ============================================================================
// models.json（nek core/model-config.ts）
// ============================================================================

/** 不透明 JSON：GUI 不解释，但必须原样保留。 */
export const nekOpaqueJsonSchema = z.unknown();

export const nekModelCostSchema = loose({
  input: z.number().optional(),
  output: z.number().optional(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
  tiers: z
    .array(
      loose({
        inputTokensAbove: z.number(),
        input: z.number().optional(),
        output: z.number().optional(),
        cacheRead: z.number().optional(),
        cacheWrite: z.number().optional(),
      }),
    )
    .optional(),
});

/** Validate without normalizing: transport and endpoint values are persisted verbatim. */
const modelEndpointText = z
  .string()
  .refine((value) => value.trim().length > 0, "must not be blank");

export const nekModelDefinitionSchema = loose({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  api: modelEndpointText.optional(),
  baseUrl: modelEndpointText.optional(),
  reasoning: z.boolean().optional(),
  thinkingLevelMap: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
  input: z.array(z.enum(["text", "image"])).optional(),
  cost: nekModelCostSchema.optional(),
  contextWindow: z.number().positive().optional(),
  maxTokens: z.number().positive().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  inputLimits: nekOpaqueJsonSchema.optional(),
  promptCache: nekOpaqueJsonSchema.optional(),
  samplingParams: nekOpaqueJsonSchema.optional(),
  samplingParamsByThinkingLevel: nekOpaqueJsonSchema.optional(),
  compat: nekOpaqueJsonSchema.optional(),
});

export const nekModelOverrideSchema = loose({
  name: z.string().min(1).optional(),
  reasoning: z.boolean().optional(),
  cost: nekModelCostSchema.optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  compat: nekOpaqueJsonSchema.optional(),
});

export const nekProviderSchema = loose({
  name: z.string().min(1).optional(),
  baseUrl: modelEndpointText.optional(),
  apiKey: z.string().min(1).optional(),
  api: modelEndpointText.optional(),
  oauth: z.literal("radius").optional(),
  headers: z.record(z.string(), z.string()).optional(),
  compat: nekOpaqueJsonSchema.optional(),
  authHeader: z.boolean().optional(),
  models: z.array(nekModelDefinitionSchema).optional(),
  modelOverrides: z.record(z.string(), nekModelOverrideSchema).optional(),
});

export const nekModelsFileSchema = loose({
  providers: z.record(z.string(), nekProviderSchema),
});

export type NekModelsFile = z.infer<typeof nekModelsFileSchema>;
export type NekProviderConfig = z.infer<typeof nekProviderSchema>;
export type NekModelDefinition = z.infer<typeof nekModelDefinitionSchema>;
export type NekModelOverride = z.infer<typeof nekModelOverrideSchema>;

// ============================================================================
// settings.json（nek core/settings-manager.ts）
// ============================================================================

/** Runtime rules, not a schema derived from the Settings interface's TypeScript enums. */
export const nekSettingsFileSchema = loose({}).superRefine((settings, context) => {
  for (const { path, message } of nekSettingsIssues(settings)) {
    context.addIssue({ code: "custom", path, message });
  }
});

/** Documented settings; provider retry options belong under `retry.provider`. */
export type NekSettingsFile = Omit<NekSettingsView, "extra"> & Record<string, unknown>;

// ============================================================================
// mcp.json（nek extensions/mcp/config.ts）
// ============================================================================

export const NEK_MCP_EXPOSURE_VALUES = ["deferred", "direct", "hidden"] as const;
export const nekMcpExposureSchema = z.enum(NEK_MCP_EXPOSURE_VALUES);

const nekMcpServerBase = {
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  exposure: nekMcpExposureSchema.optional(),
  toolExposure: z.record(z.string(), nekMcpExposureSchema).optional(),
  timeout: z.number().positive().optional(),
};

export const nekMcpStdioServerSchema = loose({
  ...nekMcpServerBase,
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});

export const nekMcpHttpServerSchema = loose({
  ...nekMcpServerBase,
  type: z.literal("http").optional(),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
  oauth: loose({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    callbackPort: z.number().int().min(1).max(65535).optional(),
    callbackUrl: z.string().optional(),
    scope: z.string().optional(),
    clientName: z.string().optional(),
    authServerMetadataUrl: z.string().optional(),
  }).optional(),
});

/** 项目级 `mcp.json` 只能写这三个键（与 nek 的 `OVERRIDE_KEYS` 一致）。 */
export const nekMcpOverrideSchema = loose({
  enabled: z.boolean().optional(),
  exposure: nekMcpExposureSchema.optional(),
  toolExposure: z.record(z.string(), nekMcpExposureSchema).optional(),
});

export const nekMcpServerSchema = z.union([
  nekMcpStdioServerSchema,
  nekMcpHttpServerSchema,
  nekMcpOverrideSchema,
]);

export const nekMcpFileSchema = loose({
  mcpServers: z.record(z.string(), nekMcpServerSchema).default({}),
});

export type NekMcpFile = z.infer<typeof nekMcpFileSchema>;
export type NekMcpServer = z.infer<typeof nekMcpServerSchema>;
export const NEK_MCP_OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"] as const;

export const NEK_MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/u;

// ============================================================================
// nek.yaml（nek extensions/nek/config.ts）
// ============================================================================

export const nekYamlSchema = loose({
  plan: loose({
    dir: z.string().optional(),
    shortcut: z.string().optional(),
  }).optional(),
  todo: loose({
    settleReminder: z.boolean().optional(),
    widgetMaxLines: z.number().optional(),
  }).optional(),
  subagent: loose({
    maxConcurrent: z.number().optional(),
    maxRetained: z.number().optional(),
    awaitDefaultMs: z.number().optional(),
    awaitMaxMs: z.number().optional(),
    finalTextMaxBytes: z.number().optional(),
  }).optional(),
});

export type NekYamlConfig = z.infer<typeof nekYamlSchema>;

// ============================================================================
// 校验入口
// ============================================================================

/** 校验结果：`ok: false` 时带上 zod 的路径化错误（供设置页直接显示）。 */
export type NekSchemaResult<T> =
  | { ok: true; data: T }
  | { ok: false; issues: Array<{ path: string; message: string }> };

export function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): NekSchemaResult<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map((segment) => String(segment)).join(".") || "root",
      message: issue.message,
    })),
  };
}
