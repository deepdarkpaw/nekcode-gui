/**
 * 编辑提交决策：行内重命名、设置文本/数字字段共用。
 *
 * 规则（交互规范 §7.2）：
 * - 值未变化 → 不提交，直接退出编辑；
 * - 解析或校验失败 → 不提交，返回错误文案（红框 + 文案）；
 * - 否则提交解析后的值。
 */

type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

/** 校验函数：返回错误文案表示不通过；返回 null / undefined / "" 表示通过。 */
export type FieldValidator<T> = (value: T) => string | null | undefined;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type CommitDecision<T> =
  | { kind: "unchanged" }
  | { kind: "invalid"; error: string }
  | { kind: "commit"; value: T };

interface CommitInput<T> {
  draft: string;
  current: T;
  parse: (draft: string) => ParseResult<T>;
  validate?: FieldValidator<T>;
  equals?: (a: T, b: T) => boolean;
}

/** 通用提交决策。 */
export function decideCommit<T>({
  draft,
  current,
  parse,
  validate,
  equals = Object.is,
}: CommitInput<T>): CommitDecision<T> {
  const parsed = parse(draft);
  if (!parsed.ok) {
    return { kind: "invalid", error: parsed.error };
  }
  if (equals(parsed.value, current)) {
    return { kind: "unchanged" };
  }
  const error = validate?.(parsed.value);
  if (error) {
    return { kind: "invalid", error };
  }
  return { kind: "commit", value: parsed.value };
}

/** 文本解析：默认去掉首尾空白（重命名、别名等场景不应保存首尾空格）。 */
export function parseTextDraft(draft: string, trim = true): ParseResult<string> {
  return { ok: true, value: trim ? draft.trim() : draft };
}

export interface NumberConstraints {
  min?: number;
  max?: number;
  integer?: boolean;
}

/** 数字解析：空串、非数字、非整数、越界都返回本地化错误文案。 */
export function parseNumberDraft(
  draft: string,
  constraints: NumberConstraints,
  formatMessage: FormatMessage,
): ParseResult<number> {
  const text = draft.trim();
  const value = text === "" ? Number.NaN : Number(text);
  if (!Number.isFinite(value)) {
    return { ok: false, error: formatMessage({ id: "ui.field.error.notNumber" }) };
  }
  if (constraints.integer && !Number.isInteger(value)) {
    return { ok: false, error: formatMessage({ id: "ui.field.error.notInteger" }) };
  }
  if (constraints.min !== undefined && value < constraints.min) {
    return {
      ok: false,
      error: formatMessage({ id: "ui.field.error.min" }, { min: constraints.min }),
    };
  }
  if (constraints.max !== undefined && value > constraints.max) {
    return {
      ok: false,
      error: formatMessage({ id: "ui.field.error.max" }, { max: constraints.max }),
    };
  }
  return { ok: true, value };
}
