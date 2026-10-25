/**
 * 表单对话框（交互规范 §7.2 / §7.3）：
 * - 显式"保存"；表单无效时主按钮呈禁用态，点击它显示错误并聚焦第一个出错字段；
 * - 有未保存改动时，关闭（Esc / 遮罩 / 关闭按钮 / 取消）前确认是否放弃；
 * - 打开时聚焦第一个空的必填项，关闭后焦点回到打开它的元素；
 * - Enter 提交（输入法组字中的 Enter 不提交）；保存中不可重复提交，失败原位显示原因。
 */
import { useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useFocusRestore } from "@/hooks/useFocusRestore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { focusFirstInvalidField, handleFormDialogOpenAutoFocus } from "@/lib/dialogFocus.js";
import { isImeComposing } from "@/lib/imeComposition.js";
import type { NekConfigRevision } from "@zcode/shared/nek-protocol";
import {
  useNekDirtyRegistration,
  useOnDocumentReset,
  type NekDocument,
} from "../api/useNekDocument.js";
import { NekConfirmDialog } from "./NekConfirmDialog.js";

type DraftDocument = Pick<NekDocument<NekConfigRevision>, "setDirty" | "resetToken">;

export interface NekFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** 子内容可读取 `attempted`（点过保存后才显示所有错误）。 */
  children: (state: { attempted: boolean }) => ReactNode;
  dirty: boolean;
  valid: boolean;
  /** 动词短语，如"保存服务商"、"添加服务商"。 */
  saveLabel: string;
  onSave: () => Promise<unknown>;
  /** 底部左侧的附加动作（如"测试连接"）。 */
  footerStart?: ReactNode;
  className?: string;
  /** 抽屉式（右侧）呈现。 */
  variant?: "dialog" | "drawer";
  /** 草稿对应的配置文档：打开且有改动时登记为未保存，外部修改改为显示横幅。 */
  documents?: ReadonlyArray<DraftDocument | undefined>;
  /** 文档"重新载入"时丢弃草稿。 */
  onReset?: () => void;
}

const DRAWER_CLASSNAME =
  "top-2 right-2 bottom-2 left-auto h-auto w-full max-w-lg translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)_auto] data-open:slide-in-from-right-4 data-closed:slide-out-to-right-4 sm:max-w-lg";

export function NekFormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  dirty,
  valid,
  saveLabel,
  onSave,
  footerStart,
  className,
  variant = "dialog",
  documents = [],
  onReset,
}: NekFormDialogProps) {
  useNekDirtyRegistration(documents, open && dirty);
  const resetToken = documents.reduce((sum, doc) => sum + (doc?.resetToken ?? 0), 0);
  useOnDocumentReset(resetToken, () => onReset?.());
  const { intl } = useZCodeIntl();
  const contentRef = useRef<HTMLDivElement>(null);
  const focusRestore = useFocusRestore(open);
  const [attempted, setAttempted] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const save = useAsyncAction(onSave, {
    successFeedbackMs: 0,
    onSuccess: () => close(true),
  });
  const pending = save.state.status === "pending";

  function close(force: boolean) {
    if (!force && dirty) {
      setConfirmDiscard(true);
      return;
    }
    setAttempted(false);
    save.reset();
    onOpenChange(false);
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (pending) {
      return;
    }
    if (!valid) {
      setAttempted(true);
      // 错误在下一帧渲染出 aria-invalid 后再聚焦。
      requestAnimationFrame(() => {
        if (contentRef.current) {
          focusFirstInvalidField(contentRef.current);
        }
      });
      return;
    }
    void save.run();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Enter" && isImeComposing(event)) {
      event.preventDefault();
      return;
    }
    // 多行文本里的 Enter 是换行，不提交。
    if (event.key === "Enter" && event.target instanceof HTMLTextAreaElement) {
      event.stopPropagation();
    }
  }

  const errorMessage = save.state.status === "error" ? save.state.message : null;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && !pending) {
            close(false);
          }
        }}
      >
        <DialogContent
          ref={contentRef}
          onOpenAutoFocus={handleFormDialogOpenAutoFocus}
          onCloseAutoFocus={focusRestore.onCloseAutoFocus}
          className={cn(
            "max-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl",
            variant === "drawer" && DRAWER_CLASSNAME,
            className,
          )}
        >
          <DialogHeader className="pr-8">
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <form
            id="nek-form-dialog"
            noValidate
            className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1"
            onSubmit={submit}
            onKeyDown={handleKeyDown}
          >
            {children({ attempted })}
            {/* 隐式提交需要一个 submit 按钮。 */}
            <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
          </form>
          <div className="flex flex-col gap-2">
            {errorMessage ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {errorMessage}
              </p>
            ) : null}
            <DialogFooter className="items-center sm:justify-between">
              <div className="flex min-w-0 items-center gap-2">{footerStart}</div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => close(false)}
                >
                  {intl.formatMessage({ id: "common.cancel" })}
                </Button>
                <Button
                  type="button"
                  aria-disabled={!valid || pending || undefined}
                  aria-busy={pending || undefined}
                  data-nek-primary="true"
                  className={cn(!valid && "opacity-50")}
                  onClick={() => submit()}
                >
                  {pending ? <LoaderIcon className="animate-spin" aria-hidden="true" /> : null}
                  {saveLabel}
                </Button>
              </div>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
      <NekConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={intl.formatMessage({ id: "settings.nek.form.discardTitle" })}
        description={intl.formatMessage({ id: "settings.nek.form.discardDescription" })}
        confirmLabel={intl.formatMessage({ id: "settings.nek.form.discardConfirm" })}
        destructive
        onConfirm={() => close(true)}
      />
    </>
  );
}
