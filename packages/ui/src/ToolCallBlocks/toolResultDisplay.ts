import {
  subagentIdentityDisplaySchema,
  type SubagentIdentityDisplay,
  toolCallListModelsDisplaySchema,
  type ToolCallListModelsDisplay,
} from "@zcode/shared/zcode-protocol-v4";

interface LocalAgentMessageToolResultDisplay {
  kind: "local_agent_message";
  status: "success" | "failed";
  error?: string;
  message?: string;
}

interface TaskStopToolResultDisplay {
  kind: "task_stop";
  taskId: string;
  taskType: string;
  command?: string;
  message: string;
  truncated?: boolean;
}

interface TaskOutputToolResultDisplay {
  kind: "task_output";
  retrievalStatus: "success" | "not_ready" | "timeout";
  taskStatus?: string;
  output?: string;
  truncated?: true;
}

interface RespondToCoordinatorToolResultDisplay {
  kind: "respond_to_coordinator";
  status: "success" | "failed";
}

export type ToolResultDisplay =
  | SubagentIdentityDisplay
  | LocalAgentMessageToolResultDisplay
  | TaskStopToolResultDisplay
  | TaskOutputToolResultDisplay
  | RespondToCoordinatorToolResultDisplay
  | ToolCallListModelsDisplay;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(
  value: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string") return null;
  const normalized = candidate.trim();
  return normalized.length > 0 ? candidate : null;
}

function parseDisplay(value: unknown): ToolResultDisplay | undefined {
  if (!isRecord(value)) return undefined;

  if (value.kind === "subagent_identity") {
    const parsed = subagentIdentityDisplaySchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }

  if (value.kind === "local_agent_message") {
    if (value.status !== "success" && value.status !== "failed") return undefined;
    const error = readOptionalString(value, "error");
    const message = readOptionalString(value, "message");
    if (error === null || message === null) return undefined;
    return {
      kind: "local_agent_message",
      status: value.status,
      ...(error !== undefined ? { error } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }

  if (value.kind === "task_stop") {
    const taskId = readOptionalString(value, "taskId");
    const taskType = readOptionalString(value, "taskType");
    const command = readOptionalString(value, "command");
    const message = readOptionalString(value, "message");
    const truncated = value.truncated;
    if (
      !taskId ||
      !taskType ||
      command === null ||
      !message ||
      (truncated !== undefined && typeof truncated !== "boolean")
    ) {
      return undefined;
    }
    return {
      kind: "task_stop",
      taskId,
      taskType,
      ...(command !== undefined ? { command } : {}),
      message,
      ...(truncated !== undefined ? { truncated } : {}),
    };
  }

  if (value.kind === "task_output") {
    if (
      value.retrievalStatus !== "success" &&
      value.retrievalStatus !== "not_ready" &&
      value.retrievalStatus !== "timeout"
    ) {
      return undefined;
    }
    const taskStatus = readOptionalString(value, "taskStatus");
    const output = readOptionalString(value, "output");
    const truncated = value.truncated;
    if (
      taskStatus === null ||
      (taskStatus !== undefined && taskStatus.length > 64) ||
      output === null ||
      (output !== undefined && output.length > 2_000) ||
      (truncated !== undefined && truncated !== true)
    ) {
      return undefined;
    }
    return {
      kind: "task_output",
      retrievalStatus: value.retrievalStatus,
      ...(taskStatus !== undefined ? { taskStatus } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(truncated === true ? { truncated: true } : {}),
    };
  }

  if (value.kind === "respond_to_coordinator") {
    if (value.status !== "success" && value.status !== "failed") {
      return undefined;
    }
    return {
      kind: "respond_to_coordinator",
      status: value.status,
    };
  }

  // 目录卡的 display kind：用 shared 的 strict schema 解析，保证 UI 消费侧与协议侧字段表
  // 永远同步——手写第二套结构校验是漂移温床。
  if (value.kind === "list_models") {
    const parsed = toolCallListModelsDisplaySchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }

  return undefined;
}

export function readToolResultDisplay(raw: unknown): ToolResultDisplay | undefined {
  if (!isRecord(raw)) return undefined;

  const result = isRecord(raw.result) ? raw.result : undefined;
  const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
  const rawOutput = isRecord(raw.rawOutput) ? raw.rawOutput : undefined;
  const output = isRecord(raw.output) ? raw.output : undefined;
  const candidates = [
    result?.display,
    raw.display,
    metadata?.display,
    rawOutput?.display,
    output?.display,
  ];

  for (const candidate of candidates) {
    const display = parseDisplay(candidate);
    if (display) return display;
  }

  return undefined;
}
