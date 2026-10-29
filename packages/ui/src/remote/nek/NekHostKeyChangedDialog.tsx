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
  useHostKeyChangedController,
  type HostKeyChangedControllerProps,
} from "./hostKeyChangedController.js";

export type NekHostKeyChangedDialogProps = HostKeyChangedControllerProps;

export function NekHostKeyChangedDialog(props: NekHostKeyChangedDialogProps) {
  const { intl } = useZCodeIntl();
  const controller = useHostKeyChangedController(props);
  const port = controller.view.port ? `:${controller.view.port}` : "";
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) void controller.actions.close.run();
      }}
    >
      <DialogContent showCloseButton={false} onKeyDown={controller.onKeyDown} className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            主机身份发生变化：{controller.view.host}
            {port}
          </DialogTitle>
          <DialogDescription>{formatRemoteMessage(intl, controller.view.body)}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-ui-sm">
          <p className="text-foreground-subtle">{controller.view.keyType}</p>
          <div className="grid gap-2 rounded-xl border border-card-border bg-card p-3">
            <div>
              <p className="text-foreground-subtle">旧指纹</p>
              <p className="break-all font-mono text-ui-base">{controller.view.oldFingerprint}</p>
            </div>
            <div>
              <p className="text-foreground-subtle">新指纹</p>
              <p className="break-all font-mono text-ui-base">{controller.view.newFingerprint}</p>
            </div>
          </div>
          <RemoteActionError action={controller.actions.close} />
          <RemoteActionError action={controller.actions.manageHosts} />
        </div>
        <DialogFooter className="sm:justify-between">
          <RemoteActionButton
            action={controller.actions.manageHosts}
            intl={intl}
            variant="outline"
            ref={controller.focus.ref("manageHosts")}
          />
          <RemoteActionButton
            action={controller.actions.close}
            intl={intl}
            ref={controller.focus.ref("close")}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
