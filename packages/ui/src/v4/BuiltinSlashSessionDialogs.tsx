import { useId, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useFocusRestore } from "@/hooks/useFocusRestore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatUsage } from "@/nek/status/format.js";
import { useNekStatusStore } from "@/nek/status/store.js";
import { Field, invalidProps } from "@/settings/nek/components/Field.js";
import { NekFormDialog } from "@/settings/nek/components/NekFormDialog.js";
import type { BuiltinSlashDialog } from "./builtinSlashActions.js";

interface SessionDialogProps {
  sessionId: string;
  title: string;
  close: () => void;
}

function SessionInfoDialog({ sessionId, title, close }: SessionDialogProps) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const stats = useNekStatusStore((state) => state.sessions[sessionId]?.stats);
  const usage = stats ? formatUsage(stats) : null;
  const focus = useFocusRestore(true);
  const fields = [
    { id: "chat.slash.session.name", value: title || t("chat.slash.session.untitled") },
    { id: "chat.slash.session.id", value: sessionId, technical: true },
    {
      id: "chat.slash.session.file",
      value: stats?.sessionFile ?? t("chat.slash.session.noFile"),
      technical: Boolean(stats?.sessionFile),
    },
    ...(usage
      ? [
          { id: "settings.nek.modelEditor.cost.input", value: usage.input },
          { id: "settings.nek.modelEditor.cost.output", value: usage.output },
          { id: "settings.nek.modelEditor.cost.cacheRead", value: usage.cacheRead },
          { id: "settings.nek.modelEditor.cost.cacheWrite", value: usage.cacheWrite },
          { id: "chat.slash.session.totalTokens", value: usage.total },
          { id: "chat.slash.session.cost", value: usage.cost },
        ]
      : []),
  ];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={focus.onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("chat.slash.session.title")}</DialogTitle>
          <DialogDescription>{t("chat.slash.session.description")}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-ui-sm">
          {fields.map(({ id, value, technical }) => (
            <div className="contents" key={id}>
              <dt className="text-foreground-subtle">{t(id)}</dt>
              <dd className={technical ? "break-all font-mono" : "wrap-anywhere"}>{value}</dd>
            </div>
          ))}
        </dl>
        {!usage ? (
          <p role="status" className="text-ui-sm text-foreground-subtle">
            {t("chat.slash.session.statsUnavailable")}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">{t("common.close")}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameSessionDialog({
  title,
  close,
  rename,
}: SessionDialogProps & { rename: (title: string) => Promise<void> }) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const id = useId();
  const [draft, setDraft] = useState(title);
  const valid = draft.trim().length > 0;
  return (
    <NekFormDialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t("v4Pane.renameSession")}
      description={t("chat.slash.renameDescription")}
      valid={valid}
      dirty={draft !== title}
      saveLabel={t("v4Pane.renameSession")}
      onSave={async () => {
        if (draft.trim() !== title) await rename(draft.trim());
      }}
    >
      {({ attempted }) => {
        const error = attempted && !valid ? t("chat.slash.nameRequired") : null;
        return (
          <Field label={t("chat.slash.session.name")} htmlFor={id} error={error} required>
            <Input
              id={id}
              value={draft}
              required
              {...invalidProps(id, error)}
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>
        );
      }}
    </NekFormDialog>
  );
}

/** Both overlays are scoped to the session that requested them. */
export function BuiltinSlashSessionDialogs({
  kind,
  ...props
}: SessionDialogProps & {
  kind: BuiltinSlashDialog;
  rename: (title: string) => Promise<void>;
}) {
  return kind === "rename" ? <RenameSessionDialog {...props} /> : <SessionInfoDialog {...props} />;
}
