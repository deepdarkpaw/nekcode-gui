import {
  normalizeUnknownError,
  ZCODE_AGENT_PROVIDER_NOT_READY_CODE,
  type ZCodeProvider,
  type ZCodeError,
} from "@zcode/shared";
import { normalizeZCodeUiError, type ZCodeUiError } from "@/lib/zcodeUiError.js";

/** provider_not_ready 是进程启动门禁的内部等待原因，直接展示会被当成 Agent 故障。 */
export function buildModelConfigMissingUiError(): ZCodeUiError {
  // 草稿首页统一投影成已有 modelConfigMissing banner 的稳定 code。
  return {
    code: "model_config_missing",
    message: "No usable model provider is configured.",
  };
}

/**
 * 读取 nek 的模型事实失败（坏 models.json / 权限 / nek 不可用）。
 *
 * 这条错误必须可见且可重试：不能把“读不到”投影成“没有模型”，也不能静默放行首发。
 * detail 带上事实来源自己的错误文本，复制与诊断入口照常可用。
 */
export function buildModelConfigUnreadableUiError(error: unknown): ZCodeUiError {
  return {
    code: "model_config_unreadable",
    message: "Cannot read the model configuration from nek.",
    detail: getChatErrorMessage(error),
  };
}

export function isProviderNotReadyError(error: unknown): boolean {
  return normalizeUnknownError(error).code === ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
}

interface WorkspacePrepareErrorContext {
  workspacePath: string;
  provider: ZCodeProvider;
  reason:
    | "mount"
    | "retry"
    | "first-send"
    | "select-provider"
    | "reload-session"
    | "sync-model-config";
  attempt: number;
  maxAttempts: number;
  taskId?: string;
  displayMessage?: string;
}

function buildWorkspacePrepareDetail(context: WorkspacePrepareErrorContext): string {
  return (
    `workspace=${context.workspacePath} ` +
    `provider=${context.provider} ` +
    `reason=${context.reason} ` +
    `attempt=${context.attempt}/${context.maxAttempts}`
  );
}

function stringifyUnknownValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // 部分错误对象会带循环引用，序列化失败时回退到 String，避免二次抛错覆盖原始错误。
  }

  return String(value);
}

export function getChatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || String(err);
  }

  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as { message?: unknown }).message;
    const normalizedMessage = stringifyUnknownValue(message);
    if (normalizedMessage !== "undefined" && normalizedMessage.length > 0) {
      return normalizedMessage;
    }
  }

  return stringifyUnknownValue(err);
}

function buildDisplayErrorInput(err: unknown, displayMessage: string | undefined): unknown {
  if (!displayMessage) {
    return err;
  }

  const displayError = new Error(displayMessage) as Error & Record<string, unknown>;
  if (err instanceof Error) {
    displayError.name = err.name;
    displayError.stack = err.stack;
  }

  if (typeof err === "object" && err !== null) {
    const errorRecord = err as Record<string, unknown>;
    for (const key of [
      "code",
      "data",
      "detail",
      "details",
      "providerCode",
      "taskId",
      "traceId",
      "attribution",
    ] as const) {
      const value = errorRecord[key];
      if (value !== undefined) {
        displayError[key] = value;
      }
    }
  }

  return displayError;
}

export function buildWorkspacePrepareUiError(
  err: unknown,
  context: WorkspacePrepareErrorContext,
): ZCodeError & { detail?: string } {
  const normalizedError = normalizeZCodeUiError(
    buildDisplayErrorInput(err, context.displayMessage),
    {
      fallbackCode: "WORKSPACE_PREPARE_FAILED",
      taskId: context.taskId,
    },
  );
  if (normalizedError.detail) {
    return normalizedError;
  }

  return {
    ...normalizedError,
    detail: buildWorkspacePrepareDetail(context),
  };
}
