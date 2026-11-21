import { useId, useState } from "react";
import {
  MAX_NEK_RESOURCE_FILE_BYTES,
  type NekConfigScope,
  type NekResourceFileRef,
  type NekResourceQuery,
} from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNekConfigApi, useNekTarget } from "../../api/NekSettingsContext.js";
import { localizeNekError } from "../../api/nekErrors.js";
import { NekFormDialog } from "../../components/NekFormDialog.js";

type Editor =
  | { kind: "create"; scope: NekConfigScope }
  | { kind: "edit"; file: NekResourceFileRef; name: string; content: string; revision: string };

export function ResourceDialog({
  editor,
  query,
  onClose,
  onSaved,
}: {
  editor: Editor;
  query: NekResourceQuery;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const api = useNekConfigApi();
  const { target } = useNekTarget();
  const id = useId();
  const editing = editor.kind === "edit";
  const skill = query.resourceType === "skills";
  const title = t(
    editing ? "settings.nek.resources.edit" : `settings.nek.resources.create.${query.resourceType}`,
  );
  const [name, setName] = useState(editing ? editor.name : "");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState(editing ? editor.content : "");
  const [baseline, setBaseline] = useState(
    editing ? { content: editor.content, revision: editor.revision } : undefined,
  );
  const [conflicted, setConflicted] = useState(false);
  const validName = editing || /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name.trim());
  const validDescription = !skill || Boolean(description.trim());
  const validBody =
    Boolean(draft.trim()) && new TextEncoder().encode(draft).length <= MAX_NEK_RESOURCE_FILE_BYTES;
  const commit = async () => {
    try {
      if (editing && baseline) {
        await api.writePromptTemplate(target, {
          ...editor.file,
          revision: baseline.revision,
          content: draft,
        });
      } else if (editor.kind === "create") {
        await api.createResource(target, {
          ...query,
          scope: editor.scope,
          name: name.trim(),
          description,
          content: draft,
        });
      }
      onSaved();
    } catch (error) {
      const localized = localizeNekError(error, t);
      setConflicted(localized.code === "conflict");
      throw localized;
    }
  };
  const readAgain = async (keep: boolean) => {
    if (!editing) return;
    const fresh = await api.readPromptTemplate(target, editor.file);
    setBaseline(fresh);
    if (!keep) setDraft(fresh.content);
    setConflicted(false);
  };
  return (
    <NekFormDialog
      open
      onOpenChange={onClose}
      title={title}
      description={t(
        skill ? "settings.nek.resources.skillBodyHint" : "settings.nek.resources.promptBodyHint",
      )}
      dirty={editing ? draft !== baseline?.content : Boolean(name || description || draft)}
      valid={validName && validDescription && validBody && !conflicted}
      saveLabel={editing ? t("settings.nek.resources.saveTemplate") : title}
      onSave={commit}
    >
      {({ attempted }) => (
        <>
          {!editing ? (
            <>
              <label htmlFor={`${id}-name`} className="text-ui-sm">
                {t("settings.nek.resources.name")}
                <Input
                  id={`${id}-name`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={64}
                  required
                  className="font-mono"
                  aria-invalid={attempted && !validName}
                />
                <span className="text-foreground-subtle">
                  {t("settings.nek.resources.nameHint")}
                </span>
              </label>
              <label htmlFor={`${id}-description`} className="text-ui-sm">
                {t("settings.nek.resources.description")}
                <Input
                  id={`${id}-description`}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={1024}
                  required={skill}
                  aria-invalid={attempted && !validDescription}
                />
              </label>
            </>
          ) : null}
          {conflicted && (
            <div className="flex flex-wrap gap-2" role="alert">
              <AsyncButton size="sm" variant="outline" onClick={() => readAgain(false)}>
                {t("settings.nek.banner.reload")}
              </AsyncButton>
              <AsyncButton size="sm" variant="outline" onClick={() => readAgain(true)}>
                {t("settings.nek.banner.keepMine")}
              </AsyncButton>
            </div>
          )}
          <label htmlFor={`${id}-body`} className="text-ui-sm">
            {t("settings.nek.resources.body")}
            <Textarea
              id={`${id}-body`}
              className="min-h-48 font-mono"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={MAX_NEK_RESOURCE_FILE_BYTES}
              required
              aria-invalid={attempted && !validBody}
            />
            {attempted && !validBody ? (
              <span className="text-destructive">
                {t("settings.nek.resources.bodyRequired", {
                  size: MAX_NEK_RESOURCE_FILE_BYTES / 1024,
                })}
              </span>
            ) : null}
          </label>
        </>
      )}
    </NekFormDialog>
  );
}
