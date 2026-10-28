import { z } from "zod";
import { zcodeSyntheticUserMessageSourceSchema } from "../zcode-protocol-legacy-types.js";
import { timestampSchema } from "./core.js";

const factBaseFields = {
  /** 会话创建期采用的 App Memory 开关，不表示记忆读写结果。 */
  memoryEnabled: z.boolean().optional(),
  version: z.literal(1),
  eventId: z.string().min(1),
  eventSeq: z.number().int().nonnegative(),
  occurredAt: timestampSchema,
  sessionId: z.string().min(1),
  sourceCommandId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
} as const;

const toolPerformanceFactSchema = z
  .object({
    totalMs: z.number().int().nonnegative().optional(),
    permissionWaitMs: z.number().int().nonnegative().optional(),
    commandRunMs: z.number().int().nonnegative().optional(),
    firstOutputMs: z.number().int().nonnegative().optional(),
    noOutputMs: z.number().int().nonnegative().optional(),
    exitCode: z.number().int().optional(),
    timedOut: z.boolean().optional(),
    outputBytes: z.number().int().nonnegative().optional(),
    commandCategory: z.string().max(64).optional(),
    commandCount: z.number().int().nonnegative().optional(),
    commandStatus: z
      .enum(["completed", "failed", "timed_out", "cancelled", "spawn_error", "backgrounded"])
      .optional(),
    fsReadMs: z.number().int().nonnegative().optional(),
    fsWriteMs: z.number().int().nonnegative().optional(),
    patchMatchMs: z.number().int().nonnegative().optional(),
    fileCount: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().nonnegative().optional(),
    maxFileBytes: z.number().int().nonnegative().optional(),
    hunkCount: z.number().int().nonnegative().optional(),
    matchAttempts: z.number().int().nonnegative().optional(),
    workspaceKind: z.enum(["local", "remote", "unknown"]).optional(),
  })
  .strict();

const turnStartedFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("turn.started"),
    executionKind: z.enum(["agent", "controlOnly"]).optional(),
    inputSource: zcodeSyntheticUserMessageSourceSchema.optional(),
    backgroundSource: z.enum(["bash", "subagent"]).optional(),
    offPeakRunType: z.enum(["init", "resume"]).optional(),
    taskTrigger: z.enum(["schedule", "manual"]).optional(),
    scheduledAt: timestampSchema.optional(),
  })
  .strict();

const modelRequestStatusFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("model.request.status"),
    requestId: z.string().min(1),
    status: z.enum([
      "model_request_started",
      "model_request_completed",
      "model_request_failed",
      "model_retry_scheduled",
      "model_stream_stalled",
    ]),
    transport: z.string(),
    querySource: z.string().optional(),
    queryId: z.string().min(1).optional(),
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative().optional(),
    reason: z.string().optional(),
    retryable: z.boolean().optional(),
    statusCode: z.number().int().optional(),
    delayMs: z.number().nonnegative().optional(),
    nextAttempt: z.number().int().nonnegative().optional(),
    idleMs: z.number().nonnegative().optional(),
    timeoutMs: z.number().nonnegative().optional(),
  })
  .strict();

const streamChunkFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("stream.chunk"),
    channel: z.enum(["thought", "text"]),
    chunkLength: z.number().int().nonnegative(),
    firstChunk: z.boolean(),
    assistantMessageId: z.string().min(1).optional(),
    partId: z.string().min(1).optional(),
    parentToolCallId: z.string().min(1).optional(),
  })
  .strict();

const toolLifecycleFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("tool.lifecycle"),
    phase: z.enum(["scheduled", "started", "progress", "completed", "failed"]),
    toolCallId: z.string().min(1),
    toolName: z
      .enum([
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Skill",
        "Task",
        "AskUserQuestion",
        "CronCreate",
        "WebFetch",
        "WebSearch",
        "other",
      ])
      .optional(),
    durationMs: z.number().nonnegative().optional(),
    parentToolCallId: z.string().min(1).optional(),
    childToolCallId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    childSessionId: z.string().min(1).optional(),
    background: z.boolean().optional(),
    performance: toolPerformanceFactSchema.optional(),
  })
  .strict();

const permissionLifecycleFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("permission.lifecycle"),
    phase: z.enum(["requested", "resolved", "denied"]),
    requestId: z.string().min(1).optional(),
    toolCallId: z.string().min(1),
    toolName: z
      .enum([
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Skill",
        "Task",
        "AskUserQuestion",
        "CronCreate",
        "WebFetch",
        "WebSearch",
        "other",
      ])
      .optional(),
    childSessionId: z.string().min(1).optional(),
    background: z.boolean().optional(),
    decision: z.enum(["allow", "deny", "escalate", "modify"]).optional(),
  })
  .strict();

const usageDeltaFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("usage.delta"),
    requestId: z.string().min(1).optional(),
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    reasoningTokens: z.number().nonnegative(),
    cacheReadTokens: z.number().nonnegative(),
    cacheWriteTokens: z.number().nonnegative(),
  })
  .strict();

const subagentLifecycleFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("subagent.lifecycle"),
    phase: z.enum(["spawned", "stopped"]),
    agentId: z.string().min(1),
    childSessionId: z.string().min(1),
    parentToolCallId: z.string().min(1).optional(),
    background: z.boolean(),
    status: z.string().optional(),
  })
  .strict();

const turnTerminalFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("turn.terminal"),
    status: z.enum(["success", "interrupted", "failed"]),
    resultType: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    tokenCount: z.number().nonnegative().optional(),
    toolCallCount: z.number().int().nonnegative().optional(),
    errorRetryable: z.boolean().optional(),
    turnPhase: z.string().optional(),
    backgroundSubagentResultConsumed: z.boolean().optional(),
  })
  .strict();

const compactionTerminalFactSchema = z
  .object({
    ...factBaseFields,
    kind: z.literal("compaction.terminal"),
    operationId: z.string().min(1),
    messageId: z.string().min(1).optional(),
    summaryMessageId: z.string().min(1).optional(),
    status: z.enum(["completed", "failed", "interrupted"]),
    trigger: z.enum(["manual", "auto", "partial", "reactive", "session_memory"]),
    compactReason: z.string().optional(),
    reason: z.string().optional(),
    attempt: z.number().int().positive().optional(),
    maxAttempts: z.number().int().positive().optional(),
    startedAt: timestampSchema.optional(),
    endedAt: timestampSchema.optional(),
    preCompactTokenCount: z.number().int().nonnegative().optional(),
    postCompactTokenCount: z.number().int().nonnegative().optional(),
    truePostCompactTokenCount: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * CLI 经 `v4/telemetry/event` 上送的实时会话事实，供桌面埋点与运行中会话统计消费。
 * 每个分支都 strict，避免新增 runtime 字段时把 prompt、工具输入或 provider URL 意外外带。
 */
const conversationTelemetryFactRuntimeSchema = z.discriminatedUnion("kind", [
  turnStartedFactSchema,
  modelRequestStatusFactSchema,
  streamChunkFactSchema,
  toolLifecycleFactSchema,
  permissionLifecycleFactSchema,
  usageDeltaFactSchema,
  subagentLifecycleFactSchema,
  turnTerminalFactSchema,
  compactionTerminalFactSchema,
]);

export type ConversationTelemetryFact = z.infer<typeof conversationTelemetryFactRuntimeSchema>;
export const conversationTelemetryFactSchema = conversationTelemetryFactRuntimeSchema;
