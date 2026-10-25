/**
 * 行内编辑（交互规范 §7.2：会话、标签、别名重命名）：
 * - 进入编辑时全选文字；
 * - Enter 提交、Esc 取消、失焦提交；值未变化时直接退出；
 * - 校验失败显示红框与文案，不提交，保持编辑态；
 * - onCommit 可返回 Promise：等待期间输入只读，失败时原位显示原因并保持编辑态。
 *
 * ```tsx
 * <InlineEdit
 *   value={title}
 *   editing={renaming}
 *   onEditingChange={setRenaming}
 *   validate={(next) => (next ? null : intl.formatMessage({ id: "…" }))}
 *   onCommit={(next) => renameSession(id, next)}
 * />
 * ```
 */
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { cn } from "../lib/utils.js";
import { Input } from "./input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { describeAsyncError } from "@/lib/asyncAction.js";
import { decideCommit, parseTextDraft, type FieldValidator } from "@/lib/editCommit.js";
import { isImeComposing } from "@/lib/imeComposition.js";

export interface InlineEditProps {
  value: string;
  onCommit: (next: string) => Promise<void> | void;
  validate?: FieldValidator<string>;
  editing?: boolean;
  defaultEditing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /** 提交前去掉首尾空白，默认 true。 */
  trim?: boolean;
  placeholder?: string;
  "aria-label"?: string;
  className?: string;
  inputClassName?: string;
  size?: "xs" | "sm" | "default" | "lg";
  /** 非编辑态的展示内容；默认显示 value，双击进入编辑。 */
  children?: ReactNode;
}

export function InlineEdit({
  value,
  editing: editingProp,
  defaultEditing = false,
  onEditingChange,
  className,
  children,
  ...editorProps
}: InlineEditProps) {
  const [editing, setEditing] = useControllableState<boolean>({
    prop: editingProp,
    defaultProp: defaultEditing,
    onChange: onEditingChange,
    caller: "InlineEdit",
  });

  if (!editing) {
    return (
      <span
        data-slot="inline-edit-display"
        className={cn("min-w-0 truncate", className)}
        onDoubleClick={() => setEditing(true)}
      >
        {children ?? value}
      </span>
    );
  }
  return (
    <InlineEditor
      {...editorProps}
      value={value}
      className={className}
      onFinish={() => setEditing(false)}
    />
  );
}

interface InlineEditorProps extends Omit<
  InlineEditProps,
  "editing" | "defaultEditing" | "onEditingChange" | "children"
> {
  onFinish: () => void;
}

function InlineEditor({
  value,
  onCommit,
  validate,
  trim = true,
  placeholder,
  "aria-label": ariaLabel,
  className,
  inputClassName,
  size = "sm",
  onFinish,
}: InlineEditorProps) {
  const { intl } = useZCodeIntl();
  const inputRef = useRef<HTMLInputElement>(null);
  const finishedRef = useRef(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const errorId = useId();

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = () => {
    finishedRef.current = true;
    onFinish();
  };

  const commit = async () => {
    if (finishedRef.current || pending) {
      return;
    }
    const decision = decideCommit({
      draft,
      current: value,
      parse: (raw) => parseTextDraft(raw, trim),
      validate,
    });
    if (decision.kind === "unchanged") {
      finish();
      return;
    }
    if (decision.kind === "invalid") {
      setError(decision.error);
      return;
    }
    setPending(true);
    try {
      await onCommit(decision.value);
      finish();
    } catch (commitError) {
      setPending(false);
      setError(
        describeAsyncError(commitError, intl.formatMessage({ id: "ui.asyncAction.failed" })),
      );
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void commit();
      return;
    }
    if (event.key === "Escape") {
      // 只取消编辑，不让外层对话框/面板一起关闭。
      event.preventDefault();
      event.stopPropagation();
      finish();
    }
  };

  return (
    <span data-slot="inline-edit" className={cn("inline-flex min-w-0 flex-col gap-1", className)}>
      <Input
        ref={inputRef}
        size={size}
        value={draft}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={error !== null || undefined}
        aria-describedby={error !== null ? errorId : undefined}
        aria-busy={pending || undefined}
        readOnly={pending}
        className={inputClassName}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => void commit()}
      />
      {error !== null ? (
        <span id={errorId} role="alert" className="text-ui-sm text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
