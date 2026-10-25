/**
 * 设置中心错误：RPC 把错误序列化为 `{ code, message, fieldErrors? }`（不是 Error 实例），
 * 这里统一转成带 code 的 Error，便于共享原语（AsyncButton、设置字段）直接显示 message。
 */
import type { INekConfigApi, NekConfigErrorCode } from "@zcode/shared/nek-protocol";

const ERROR_CODES: ReadonlySet<string> = new Set<NekConfigErrorCode>([
  "conflict",
  "validation",
  "not_connected",
  "nek_unavailable",
  "io",
]);

export class NekConfigApiError extends Error {
  readonly code: NekConfigErrorCode;
  readonly fieldErrors?: Record<string, string>;

  constructor(code: NekConfigErrorCode, message: string, fieldErrors?: Record<string, string>) {
    super(message);
    this.name = "NekConfigApiError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

function readField(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

/** 任意抛出值 → NekConfigApiError；未知形状归为 io，保留原始文案。 */
export function toNekConfigApiError(error: unknown): NekConfigApiError {
  if (error instanceof NekConfigApiError) {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const code = readField(error, "code");
    const message = readField(error, "message");
    const fieldErrors = readField(error, "fieldErrors");
    if (typeof code === "string" && ERROR_CODES.has(code)) {
      return new NekConfigApiError(
        code as NekConfigErrorCode,
        typeof message === "string" ? message : code,
        typeof fieldErrors === "object" && fieldErrors !== null
          ? (fieldErrors as Record<string, string>)
          : undefined,
      );
    }
    if (typeof message === "string") {
      return new NekConfigApiError("io", message);
    }
  }
  return new NekConfigApiError("io", typeof error === "string" ? error : String(error));
}

export function isNekConflictError(error: unknown): boolean {
  return error instanceof NekConfigApiError && error.code === "conflict";
}

type Translate = (id: string, values?: Record<string, string | number>) => string;

/** 已知错误码的本地化文案；io / validation 使用后端给出的具体原因。 */
export function localizeNekError(error: unknown, t: Translate): NekConfigApiError {
  const normalized = toNekConfigApiError(error);
  switch (normalized.code) {
    case "conflict":
      return new NekConfigApiError("conflict", t("settings.nek.error.conflict"));
    case "not_connected":
      return new NekConfigApiError("not_connected", t("settings.nek.error.notConnected"));
    case "nek_unavailable":
      return new NekConfigApiError(
        "nek_unavailable",
        t("settings.nek.error.nekUnavailable", { message: normalized.message }),
      );
    default:
      return normalized;
  }
}

/**
 * 包装 API：所有返回 Promise 的方法失败时统一抛出 NekConfigApiError。
 * 非 Promise 返回值（watch / onLoginEvent 的取消函数）原样透传。
 */
export function wrapNekConfigApi(api: INekConfigApi): INekConfigApi {
  return new Proxy(api, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        const result: unknown = value.apply(target, args);
        if (result instanceof Promise) {
          return result.catch((error: unknown) => {
            throw toNekConfigApiError(error);
          });
        }
        return result;
      };
    },
  });
}
