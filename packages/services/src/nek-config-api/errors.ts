/**
 * 设置中心的错误形状。
 *
 * 契约要求所有方法失败时抛出 `{ code, message, fieldErrors? }`（`NekConfigError`）。这里的类既能被
 * `instanceof` 判断（host 内部、测试），也能跨 RPC 序列化成同一个形状（renderer 侧
 * `toNekConfigApiError` 读的正是这三个字段）。
 */
import type { NekConfigErrorCode, NekConfigTarget } from "@zcode/shared/nek-protocol";
import { NekConfigConflictError, NekConfigParseError } from "../nek-agent/config/nekConfigFs.js";

/** 跨 RPC 的普通对象形状（JSON 化后字段不变）。 */
export interface NekConfigErrorShape {
  code: NekConfigErrorCode;
  message: string;
  fieldErrors?: Record<string, string>;
}

export class NekConfigError extends Error implements NekConfigErrorShape {
  readonly code: NekConfigErrorCode;
  readonly fieldErrors?: Record<string, string>;

  constructor(code: NekConfigErrorCode, message: string, fieldErrors?: Record<string, string>) {
    super(message);
    this.name = "NekConfigError";
    this.code = code;
    if (fieldErrors && Object.keys(fieldErrors).length > 0) this.fieldErrors = fieldErrors;
  }

  toJSON(): NekConfigErrorShape {
    return this.fieldErrors
      ? { code: this.code, message: this.message, fieldErrors: this.fieldErrors }
      : { code: this.code, message: this.message };
  }
}

/** 目标未连接（远程主机断开时每次调用都要报这个，而不是假装成功）。 */
export function notConnected(target: NekConfigTarget): NekConfigError {
  const label = target.kind === "local" ? "local" : `remote:${target.connectionId}`;
  return new NekConfigError("not_connected", `${label} is not connected`);
}

/** 目标机器上没有可用的 nek（未安装 / 版本不兼容 / 启动失败）。 */
export function nekUnavailable(message: string): NekConfigError {
  return new NekConfigError("nek_unavailable", message);
}

/** 文件在读取之后被外部改过。 */
export function conflict(path: string): NekConfigError {
  return new NekConfigError("conflict", `${path} was modified externally; reload before writing`);
}

export function ioError(message: string): NekConfigError {
  return new NekConfigError("io", message);
}

export function validationError(
  message: string,
  fieldErrors?: Record<string, string>,
): NekConfigError {
  return new NekConfigError("validation", message, fieldErrors);
}

/** zod / schema 校验结果 → 字段级错误（`path: message`）。 */
export function fieldErrorsOf(
  issues: ReadonlyArray<{ path: string; message: string }>,
): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) fieldErrors[issue.path || "(root)"] = issue.message;
  return fieldErrors;
}

/** 任意抛出值 → `NekConfigError`；未知形状归为 `io` 并保留原文（不吞错）。 */
export function asNekConfigError(
  error: unknown,
  fallbackCode: NekConfigErrorCode = "io",
): NekConfigError {
  if (error instanceof NekConfigError) return error;
  if (error instanceof NekConfigConflictError) return conflict(error.path);
  if (error instanceof NekConfigParseError)
    return new NekConfigError("validation", error.message, { [error.path]: error.detail });
  const message = error instanceof Error ? error.message : String(error);
  return new NekConfigError(fallbackCode, message);
}
