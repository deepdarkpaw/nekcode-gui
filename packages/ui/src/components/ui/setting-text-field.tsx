/**
 * 文本 / 数字设置字段（交互规范 §7.2）：
 * - 失焦或 Enter 提交，Esc 恢复原值；值未变化不提交；
 * - 校验不通过不提交，显示红框与错误文案；保存失败保留输入并显示原因；
 * - 数字字段带单位后缀；取值不是默认值时显示「恢复默认」。
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../lib/utils.js";
import { Button } from "./button.js";
import { Input } from "./input.js";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "./input-group.js";
import { SettingRow } from "./setting-fields.js";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  decideCommit,
  parseNumberDraft,
  parseTextDraft,
  type FieldValidator,
  type NumberConstraints,
  type ParseResult,
} from "@/lib/editCommit.js";
import { isImeComposing } from "@/lib/imeComposition.js";

interface CommitFieldProps<T> {
  label: ReactNode;
  description?: ReactNode;
  value: T;
  /** 默认值；当前值不同于它时显示「恢复默认」。 */
  defaultValue?: T;
  onCommit: (value: T) => Promise<void>;
  validate?: FieldValidator<T>;
  disabled?: boolean;
  placeholder?: string;
  /** 单位后缀（如 `s`、`KB`、`tokens`）。 */
  unit?: string;
  inputClassName?: string;
}

interface CommitFieldCodec<T> {
  format: (value: T) => string;
  parse: (draft: string) => ParseResult<T>;
  inputMode?: "text" | "decimal" | "numeric";
}

function CommitField<T>({
  label,
  description,
  value,
  defaultValue,
  onCommit,
  validate,
  disabled,
  placeholder,
  unit,
  inputClassName,
  codec,
}: CommitFieldProps<T> & { codec: CommitFieldCodec<T> }) {
  const { intl } = useZCodeIntl();
  const id = useId();
  const [draft, setDraft] = useState(() => codec.format(value));
  const [validationError, setValidationError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const action = useAsyncAction(onCommit);
  const formatRef = useRef(codec.format);
  formatRef.current = codec.format;

  /** 刚保存成功、props 尚未跟上的值；避免 Enter 提交后的失焦再次提交同一个值。 */
  const committedRef = useRef<{ value: T } | null>(null);

  // 外部值变化（保存成功、外部修改）时，未编辑的输入框跟随新值。
  useEffect(() => {
    committedRef.current = null;
    if (!dirtyRef.current) {
      setDraft(formatRef.current(value));
    }
  }, [value]);

  const restore = () => {
    dirtyRef.current = false;
    setDraft(codec.format(committedRef.current ? committedRef.current.value : value));
    setValidationError(null);
    action.reset();
  };

  const save = async (next: T) => {
    setValidationError(null);
    if (await action.run(next)) {
      dirtyRef.current = false;
      committedRef.current = { value: next };
      setDraft(codec.format(next));
    }
  };

  const submit = () => {
    const current = committedRef.current ? committedRef.current.value : value;
    const decision = decideCommit({ draft, current, parse: codec.parse, validate });
    if (decision.kind === "unchanged") {
      restore();
      return;
    }
    if (decision.kind === "invalid") {
      setValidationError(decision.error);
      return;
    }
    void save(decision.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      restore();
    }
  };

  const invalid = validationError !== null || action.state.status === "error";
  const inputProps = {
    id,
    value: draft,
    disabled,
    placeholder,
    inputMode: codec.inputMode,
    "aria-invalid": invalid || undefined,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      dirtyRef.current = true;
      setDraft(event.target.value);
      setValidationError(null);
    },
    onKeyDown: handleKeyDown,
    onBlur: submit,
  };
  const showReset = defaultValue !== undefined && !Object.is(value, defaultValue) && !disabled;

  return (
    <SettingRow
      label={label}
      description={description}
      htmlFor={id}
      state={action.state}
      error={validationError}
      trailing={
        showReset ? (
          <Button variant="ghost" size="sm" onClick={() => void save(defaultValue)}>
            {intl.formatMessage({ id: "ui.setting.resetToDefault" })}
          </Button>
        ) : null
      }
    >
      {unit ? (
        <InputGroup className={cn("w-40", inputClassName)}>
          <InputGroupInput {...inputProps} />
          <InputGroupAddon align="inline-end">
            <InputGroupText>{unit}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
      ) : (
        <Input {...inputProps} className={cn("w-56", inputClassName)} />
      )}
    </SettingRow>
  );
}

/** 文本设置字段；默认去掉首尾空白。 */
export function SettingTextField({
  trim = true,
  ...props
}: CommitFieldProps<string> & { trim?: boolean }) {
  return (
    <CommitField
      {...props}
      codec={{ format: (value) => value, parse: (draft) => parseTextDraft(draft, trim) }}
    />
  );
}

/** 数字设置字段：解析失败、非整数、越界都不提交。 */
export function SettingNumberField({
  min,
  max,
  integer,
  ...props
}: CommitFieldProps<number> & NumberConstraints) {
  const { intl } = useZCodeIntl();
  const formatMessage = intl.formatMessage.bind(intl);
  return (
    <CommitField
      {...props}
      codec={{
        format: (value) => String(value),
        parse: (draft) => parseNumberDraft(draft, { min, max, integer }, formatMessage),
        inputMode: integer ? "numeric" : "decimal",
      }}
    />
  );
}
