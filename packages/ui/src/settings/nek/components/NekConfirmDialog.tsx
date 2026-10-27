/**
 * 不可逆操作的确认框（交互规范 §7.2）：
 * - 默认焦点在"取消"（Radix AlertDialog 默认聚焦 Cancel）；
 * - 破坏性按钮用 destructive 样式放在左侧，[取消] 在右侧；非破坏性时 [取消] [主操作] 右对齐；
 * - 执行中按钮 loading、不可重复提交；失败原位显示原因、不关闭。
 */
import type { ReactNode } from "react";
import { LoaderIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Button } from "@/components/ui/button.js";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useFocusRestore } from "@/hooks/useFocusRestore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function NekConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** 动词短语，如"删除服务商"。 */
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<unknown> | unknown;
}) {
  const { intl } = useZCodeIntl();
  const focusRestore = useFocusRestore(open);
  const action = useAsyncAction(onConfirm, {
    successFeedbackMs: 0,
    onSuccess: () => onOpenChange(false),
  });
  const pending = action.state.status === "pending";
  const errorMessage = action.state.status === "error" ? action.state.message : null;

  const confirmButton = (
    <Button
      type="button"
      variant={destructive ? "destructive" : "default"}
      aria-busy={pending || undefined}
      onClick={() => void action.run()}
    >
      {pending ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : null}
      {confirmLabel}
    </Button>
  );

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          action.reset();
          onOpenChange(next);
        }
      }}
    >
      <AlertDialogContent onCloseAutoFocus={focusRestore.onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {children}
        {errorMessage ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
        <AlertDialogFooter className={destructive ? "sm:justify-between" : undefined}>
          {destructive ? confirmButton : null}
          <AlertDialogCancel disabled={pending}>
            {intl.formatMessage({ id: "common.cancel" })}
          </AlertDialogCancel>
          {destructive ? null : confirmButton}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
