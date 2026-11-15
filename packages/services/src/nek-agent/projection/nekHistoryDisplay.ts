/** Validate complete display entries before the v4 adapter; only tool-result image bytes may be absent. */
import { z } from "zod";
import type { NekSessionEntry } from "@zcode/shared/nek-protocol";

const text = z.object({ type: z.literal("text"), text: z.string() });
const image = z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() });
const content = z.union([z.string(), z.array(z.union([text, image]))]);
const usage = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  totalTokens: z.number(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
    total: z.number(),
  }),
});
const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), content, timestamp: z.number() }),
  z.object({
    role: z.literal("system"),
    content: z.union([z.string(), z.array(text)]),
    timestamp: z.number(),
  }),
  z.object({
    role: z.literal("assistant"),
    timestamp: z.number(),
    api: z.string(),
    provider: z.string(),
    model: z.string(),
    content: z.array(
      z.union([
        text,
        z.object({
          type: z.literal("thinking"),
          thinking: z.string(),
          redacted: z.boolean().optional(),
        }),
        z.object({
          type: z.literal("toolCall"),
          id: z.string(),
          name: z.string(),
          arguments: z.record(z.string(), z.unknown()),
        }),
      ]),
    ),
    usage,
    stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"]),
    errorMessage: z.string().optional(),
  }),
  z.object({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    toolName: z.string(),
    content: z.array(z.union([text, image.omit({ data: true })])),
    details: z.unknown().optional(),
    isError: z.boolean(),
    timestamp: z.number(),
  }),
  z.object({
    role: z.literal("bashExecution"),
    command: z.string(),
    output: z.string(),
    exitCode: z.number().optional(),
    cancelled: z.boolean(),
    truncated: z.boolean(),
    fullOutputPath: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    role: z.literal("custom"),
    customType: z.string(),
    content,
    display: z.boolean(),
    details: z.unknown().optional(),
    timestamp: z.number(),
  }),
  z.object({
    role: z.literal("branchSummary"),
    summary: z.string(),
    fromId: z.string().nullable(),
    timestamp: z.number(),
  }),
  z.object({
    role: z.literal("compactionSummary"),
    summary: z.string(),
    tokensBefore: z.number(),
    timestamp: z.number(),
  }),
]);
const base = { id: z.string(), parentId: z.string().nullable(), timestamp: z.string() };
const entrySchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("message"), message }),
  z.object({ ...base, type: z.literal("model_change"), provider: z.string(), modelId: z.string() }),
  z.object({ ...base, type: z.literal("thinking_level_change"), thinkingLevel: z.string() }),
  z.object({ ...base, type: z.literal("session_info"), name: z.string().optional() }),
  z.object({
    ...base,
    type: z.literal("compaction"),
    summary: z.string(),
    firstKeptEntryId: z.string(),
    tokensBefore: z.number(),
    fromHook: z.boolean().optional(),
  }),
  z.object({ ...base, type: z.literal("branch_summary"), summary: z.string(), fromId: z.string() }),
  z.object({
    ...base,
    type: z.literal("custom_message"),
    customType: z.string(),
    content,
    details: z.unknown().optional(),
    display: z.boolean(),
  }),
  z.object({
    ...base,
    type: z.literal("custom"),
    customType: z.string(),
    data: z.unknown().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("label"),
    targetId: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal("context_edit"),
    targetId: z.string(),
    replacement: z.object({ content: z.unknown() }).nullable(),
  }),
  z.object({
    ...base,
    type: z.literal("usage"),
    kind: z.string(),
    provider: z.string(),
    model: z.string(),
    usage,
  }),
]);
export function validateHistoryDisplay(value: unknown): NekSessionEntry {
  const entry = entrySchema.parse(value);
  if (entry.type === "message" && entry.message.role === "bashExecution")
    return { ...entry, message: { ...entry.message, exitCode: entry.message.exitCode } };
  if (entry.type === "message") {
    const parsed = message.parse(entry.message);
    if (parsed.role === "bashExecution") throw new Error("unreachable bash display");
    return { ...entry, message: parsed };
  }
  return entry;
}
