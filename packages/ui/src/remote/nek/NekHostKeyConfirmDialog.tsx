import { CopyIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  RemoteActionButton,
  RemoteActionError,
  formatRemoteMessage,
} from "./RemoteActionButton.js";
import {
  useHostKeyConfirmController,
  type HostKeyConfirmControllerProps,
} from "./hostKeyController.js";

export type NekHostKeyConfirmDialogProps = HostKeyConfirmControllerProps;

export function NekHostKeyConfirmDialog(props: NekHostKeyConfirmDialogProps) {
  const { intl } = useZCodeIntl();
  const controller = useHostKeyConfirmController(props);
  const port = controller.view.port ? `:${controller.view.port}` : "";
  const body = formatRemoteMessage(intl, controller.view.body);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) void controller.actions.reject.run();
      }}
    >
      <DialogContent showCloseButton={false} onKeyDown={controller.onKeyDown} className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            连接到 {controller.view.host}
            {port}
          </DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-ui-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            <dt className="text-foreground-subtle">类型</dt>
            <dd className="font-mono">{controller.view.keyType}</dd>
            <dt className="text-foreground-subtle">指纹</dt>
            <dd className="break-all font-mono text-ui-base">{controller.view.fingerprint}</dd>
          </dl>
          <RemoteActionError action={controller.actions.trust} />
          <RemoteActionError action={controller.actions.reject} />
          <RemoteActionError action={controller.actions.copyFingerprint} />
        </div>
        <DialogFooter className="sm:justify-between">
          <RemoteActionButton
            action={controller.actions.copyFingerprint}
            intl={intl}
            variant="ghost"
          >
            <CopyIcon aria-hidden="true" />
            {formatRemoteMessage(intl, controller.actions.copyFingerprint.label)}
            {controller.view.copied ? " ✓" : null}
          </RemoteActionButton>
          <div className="flex gap-2">
            <RemoteActionButton
              action={controller.actions.reject}
              intl={intl}
              ref={controller.focus.ref("reject")}
            />
            <RemoteActionButton
              action={controller.actions.trust}
              intl={intl}
              ref={controller.focus.ref("trust")}
            />
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
