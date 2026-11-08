/**
 * nekcode-gui 运行参数（`config/config.yaml`）的 schema 与默认值。
 *
 * 只做解析与校验，不读文件；读文件见 `@zcode/services` 的 `loadGuiRuntimeConfig`。
 * 缺失的键取默认值；非法的键记入诊断并回退到该键的默认值，其余键照常生效。
 */
import { z } from "zod";

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

const nekSchema = z.object({
  maxSessionProcesses: positiveInt.max(64),
  idleMinutes: positiveInt,
  stderrBufferKb: positiveInt,
  maxLineMb: positiveInt.max(1024),
  maxConversationPlans: positiveInt.max(500),
  /** 压缩期间 GUI 暂存的待发送输入上限（每条会话）。 */
  pendingInputsPerSession: positiveInt.max(64),
});

const timeoutsSchema = z.object({
  commandMs: positiveInt,
  promptPreflightMs: positiveInt,
  longRunningMs: positiveInt,
  shutdownGraceMs: nonNegativeInt,
  /** host 等渲染层回答一次交互请求（含项目信任）的上限。 */
  interactionMs: positiveInt,
  /**
   * 压缩期间 GUI 暂存输入的排队等待上限（不含进入提交后的 RPC 时间）。
   * 到点可见失败、草稿回到输入框，绝不补发。
   */
  pendingInputMs: positiveInt,
});

const eventsSchema = z.object({
  streamFlushPerSecond: positiveInt.max(120),
  foldStateEntries: positiveInt,
  queueEntries: positiveInt,
  draftEntries: positiveInt,
  eventBufferEntries: positiveInt,
  /** 同时在等渲染层回答的交互请求上限（有界内存）。 */
  pendingInteractions: positiveInt.max(256),
});

const remoteSchema = z.object({
  reconnectBackoffSeconds: z.array(positiveInt).min(1).max(16),
  requireHostKeyConfirmation: z.boolean(),
  configPollSeconds: positiveInt,
  recentDirectories: positiveInt.max(200),
});

const inputSchema = z.object({
  pasteCollapseChars: positiveInt,
  pasteCollapseLines: positiveInt,
  draftAutosaveMs: positiveInt,
  undoToastMs: positiveInt,
});

const loggingSchema = z.object({
  dir: z.string().min(1),
  maxFileMb: positiveInt,
  keepFiles: positiveInt.max(50),
  perProcessStderr: z.boolean(),
});

const updatesSchema = z.object({
  channel: z.enum(["stable", "dev"]),
  checkIntervalHours: positiveInt,
});

const sectionSchemas = {
  nek: nekSchema,
  timeouts: timeoutsSchema,
  events: eventsSchema,
  remote: remoteSchema,
  input: inputSchema,
  logging: loggingSchema,
  updates: updatesSchema,
} as const;

type SectionName = keyof typeof sectionSchemas;

export type GuiRuntimeConfig = {
  [K in SectionName]: z.infer<(typeof sectionSchemas)[K]>;
};

/** 内置默认值，与仓库 `config/config.yaml` 保持一致。 */
export const DEFAULT_GUI_RUNTIME_CONFIG: GuiRuntimeConfig = {
  nek: {
    maxSessionProcesses: 8,
    idleMinutes: 10,
    stderrBufferKb: 512,
    maxLineMb: 64,
    maxConversationPlans: 100,
    pendingInputsPerSession: 16,
  },
  timeouts: {
    commandMs: 15_000,
    promptPreflightMs: 20_000,
    longRunningMs: 180_000,
    shutdownGraceMs: 1_500,
    interactionMs: 300_000,
    pendingInputMs: 600_000,
  },
  events: {
    streamFlushPerSecond: 20,
    foldStateEntries: 2_000,
    queueEntries: 200,
    draftEntries: 20,
    eventBufferEntries: 5_000,
    pendingInteractions: 32,
  },
  remote: {
    reconnectBackoffSeconds: [1, 2, 4, 8, 16],
    requireHostKeyConfirmation: true,
    configPollSeconds: 5,
    recentDirectories: 20,
  },
  input: {
    pasteCollapseChars: 2_000,
    pasteCollapseLines: 40,
    draftAutosaveMs: 800,
    undoToastMs: 5_000,
  },
  logging: { dir: "logs", maxFileMb: 5, keepFiles: 3, perProcessStderr: true },
  updates: { channel: "stable", checkIntervalHours: 6 },
};

/** 一条配置诊断：`path` 为点分键路径（如 `nek.idleMinutes`）。 */
export interface GuiRuntimeConfigDiagnostic {
  path: string;
  message: string;
}

export interface GuiRuntimeConfigParseResult {
  config: GuiRuntimeConfig;
  diagnostics: GuiRuntimeConfigDiagnostic[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 逐键合并一个分节：合法键覆盖默认值，非法键记诊断，未知键记诊断后忽略。 */
function parseSection<K extends SectionName>(
  name: K,
  raw: unknown,
  diagnostics: GuiRuntimeConfigDiagnostic[],
): GuiRuntimeConfig[K] {
  const defaults = DEFAULT_GUI_RUNTIME_CONFIG[name];
  if (raw === undefined || raw === null) return defaults;
  if (!isRecord(raw)) {
    diagnostics.push({ path: name, message: "must be a mapping" });
    return defaults;
  }
  const shape = sectionSchemas[name].shape as Record<string, z.ZodType>;
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(raw)) {
    const fieldSchema = shape[key];
    if (!fieldSchema) {
      diagnostics.push({ path: `${name}.${key}`, message: "unknown key" });
      continue;
    }
    const parsed = fieldSchema.safeParse(value);
    if (parsed.success) {
      merged[key] = parsed.data;
      continue;
    }
    diagnostics.push({
      path: `${name}.${key}`,
      message: parsed.error.issues[0]?.message ?? "invalid value",
    });
  }
  return merged as GuiRuntimeConfig[K];
}

/** 解析已经反序列化的 YAML 文档（`undefined` 表示文件不存在或为空）。 */
export function parseGuiRuntimeConfig(document: unknown): GuiRuntimeConfigParseResult {
  const diagnostics: GuiRuntimeConfigDiagnostic[] = [];
  if (document !== undefined && document !== null && !isRecord(document)) {
    return {
      config: DEFAULT_GUI_RUNTIME_CONFIG,
      diagnostics: [{ path: "", message: "config root must be a mapping" }],
    };
  }
  const root = (document ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!(key in sectionSchemas)) diagnostics.push({ path: key, message: "unknown section" });
  }
  const config = Object.fromEntries(
    (Object.keys(sectionSchemas) as SectionName[]).map((name) => [
      name,
      parseSection(name, root[name], diagnostics),
    ]),
  ) as GuiRuntimeConfig;
  return { config, diagnostics };
}
