import { EyeIcon, EyeOffIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  RemoteActionButton,
  RemoteActionError,
  formatRemoteMessage,
} from "./RemoteActionButton.js";
import {
  useCredentialPromptController,
  type CredentialPromptControllerProps,
} from "./credentialController.js";

export type NekCredentialPromptDialogProps = CredentialPromptControllerProps;

export function NekCredentialPromptDialog(props: NekCredentialPromptDialogProps) {
  const { intl } = useZCodeIntl();
  const controller = useCredentialPromptController(props);
  const toggleLabel = formatRemoteMessage(intl, controller.view.toggleRevealLabel);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) void controller.actions.cancel.run();
      }}
    >
      <DialogContent showCloseButton={false} onKeyDown={controller.onKeyDown} className="max-w-md">
        <DialogHeader>
          <DialogTitle>{formatRemoteMessage(intl, controller.view.title)}</DialogTitle>
          <DialogDescription>
            {formatRemoteMessage(intl, controller.view.description)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input
              ref={controller.focus.ref("input")}
              type={controller.view.revealed ? "text" : "password"}
              value={controller.view.value}
              autoComplete="off"
              onChange={(event) => controller.setValue(event.target.value)}
              aria-label={formatRemoteMessage(intl, controller.view.title)}
            />
            <RemoteActionButton
              action={controller.actions.toggleReveal}
              intl={intl}
              variant="ghost"
            >
              {controller.view.revealed ? (
                <EyeOffIcon aria-hidden="true" />
              ) : (
                <EyeIcon aria-hidden="true" />
              )}
              {toggleLabel}
            </RemoteActionButton>
          </div>
          <RemoteActionError action={controller.actions.submit} />
          <RemoteActionError action={controller.actions.cancel} />
          <RemoteActionError action={controller.actions.toggleReveal} />
        </div>
        <DialogFooter>
          <RemoteActionButton
            action={controller.actions.cancel}
            intl={intl}
            variant="ghost"
            ref={controller.focus.ref("cancel")}
          />
          <RemoteActionButton
            action={controller.actions.submit}
            intl={intl}
            ref={controller.focus.ref("submit")}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
