/**
 * 对话框表单字段：标签 + 控件 + 说明 + 错误。错误时控件须带 `aria-invalid`（由调用方传入），
 * 以便 `focusFirstInvalidField` 定位。
 */
import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
  trailing,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
  /** 标签右侧的附加内容（如"修改 ID"链接）。 */
  trailing?: ReactNode;
}) {
  return (
    <div data-slot="nek-field" className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="text-ui-sm font-medium text-foreground">
          {label}
          {required ? (
            <span aria-hidden="true" className="ml-0.5 text-destructive">
              *
            </span>
          ) : null}
        </label>
        {trailing}
      </div>
      {children}
      {error ? (
        <p
          role="alert"
          id={htmlFor ? `${htmlFor}-error` : undefined}
          className="text-ui-sm text-destructive"
        >
          {error}
        </p>
      ) : hint ? (
        <p className="text-ui-sm text-foreground-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

/** 控件的错误属性：aria-invalid + aria-describedby。 */
export function invalidProps(id: string, error: string | null | undefined) {
  return error ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {};
}
