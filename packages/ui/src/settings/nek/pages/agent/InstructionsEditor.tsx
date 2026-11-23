/**
 * 指令文件编辑器：显式保存（Ctrl/⌘+S 或按钮），可还原；有未保存改动时登记 dirty，
 * 外部修改改为显示横幅而不是覆盖草稿；"重新载入"会丢弃草稿。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { NekConfigScope, NekInstructionsView } from "@zcode/shared/nek-protocol";
import { ActionTooltip } from "@/components/ui/action-tooltip.js";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
import { SettingSection } from "@/components/ui/setting-fields.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isImeComposing } from "@/lib/imeComposition.js";
import { formatActionBindingLabel } from "@/shortcuts/actionBinding.js";
import { useNekSettingsContext } from "../../api/NekSettingsContext.js";
import { useNekInstructionsDoc } from "../../api/settingsDocs.js";
import { useNekDirtyRegistration, useOnDocumentReset } from "../../api/useNekDocument.js";
import { DiagnosticsList, DocumentBanners, DocumentGate } from "../../components/DocumentStatus.js";
import { AgentFileOpenButton } from "./AgentFileOpenButton.js";

interface InstructionsEditorProps {
  scope: NekConfigScope;
  cwd?: string;
  title: string;
}

export function InstructionsEditor(props: InstructionsEditorProps) {
  const { targetKey } = useNekSettingsContext();
  return (
    <InstructionsEditorImpl key={JSON.stringify([targetKey, props.scope, props.cwd])} {...props} />
  );
}

function InstructionsEditorImpl({ scope, cwd, title }: InstructionsEditorProps) {
  const { intl } = useZCodeIntl();
  const doc = useNekInstructionsDoc(scope, cwd);
  const saved = doc.data?.content ?? "";
  const path = doc.data?.path;
  const heading = doc.data ? `${title} · ${doc.data.filename}` : title;
  // No draft until the user types. Keep its file identity if a watch changes the winner.
  const [draft, setDraft] = useState<{ path: string; content: string }>();
  const value = draft?.content ?? saved;
  const fileChanged = draft && draft.path !== path;
  const dirty = Boolean(draft && (fileChanged || value !== saved));
  const changedReason = fileChanged
    ? intl.formatMessage({ id: "settings.nek.instructions.fileChanged" }, { path: draft.path })
    : undefined;
  const noChanges = intl.formatMessage({ id: "settings.nek.instructions.noChanges" });
  useEffect(() => {
    // Only confirmed content from the original file can clear the draft.
    setDraft((current) =>
      current?.path === path && current?.content === saved ? undefined : current,
    );
  }, [path, saved]);
  useOnDocumentReset(doc.resetToken, () => setDraft(undefined));
  useNekDirtyRegistration([doc], dirty);
  const saveButtonRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(event)) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveButtonRef.current?.querySelector("button")?.click();
    }
  };

  return (
    <SettingSection
      title={heading}
      description={path ? <span className="break-all font-mono">{path}</span> : undefined}
    >
      <DocumentBanners documents={[doc]} />
      <DocumentGate documents={[doc]}>
        {() =>
          doc.data && (
            <div className="flex flex-col gap-2">
              <InstructionFileSources data={doc.data} />
              {changedReason ? (
                <p role="status" className="break-words text-ui-sm text-warning">
                  {changedReason}
                </p>
              ) : null}
              <Textarea
                aria-label={heading}
                value={value}
                className="min-h-48 font-mono"
                onChange={(event) => {
                  const content = event.target.value;
                  if (path)
                    setDraft(
                      !fileChanged && content === saved
                        ? undefined
                        : { path: draft?.path ?? path, content },
                    );
                }}
                onKeyDown={handleKeyDown}
              />
              <div className="flex items-center justify-end gap-2">
                {dirty ? (
                  <span className="mr-auto text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.nek.instructions.unsaved" })}
                  </span>
                ) : null}
                <ActionTooltip
                  label={intl.formatMessage({ id: "settings.nek.instructions.revert" })}
                  disabled={!dirty}
                  disabledReason={noChanges}
                >
                  <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(undefined)}>
                    {intl.formatMessage({ id: "settings.nek.instructions.revert" })}
                  </Button>
                </ActionTooltip>
                <div ref={saveButtonRef}>
                  <AsyncButton
                    variant="secondary"
                    disabled={!dirty || Boolean(fileChanged)}
                    disabledReason={changedReason ?? noChanges}
                    shortcut={formatActionBindingLabel("CmdOrCtrl+s")}
                    label={intl.formatMessage({ id: "settings.nek.instructions.save" })}
                    onClick={() => doc.save(value, draft!.path)}
                  >
                    {intl.formatMessage({ id: "settings.nek.instructions.save" })}
                  </AsyncButton>
                </div>
              </div>
            </div>
          )
        }
      </DocumentGate>
    </SettingSection>
  );
}

function InstructionFileSources({ data }: { data: NekInstructionsView }) {
  const { intl } = useZCodeIntl();
  return (
    <>
      <DiagnosticsList diagnostics={data.diagnostics} />
      {data.ignored.length ? (
        <p className="break-words text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.nek.instructions.ignored" },
            {
              active: data.filename,
              ignored: data.ignored.map((file) => file.filename).join(", "),
            },
          )}
        </p>
      ) : null}
      {data.ancestors.length ? (
        <div className="flex flex-col gap-1">
          <p className="text-ui-sm font-medium">
            {intl.formatMessage({ id: "settings.nek.instructions.ancestors" })}
          </p>
          <ul className="divide-y divide-border rounded-xl border border-card-border bg-card">
            {data.ancestors.map((file) => (
              <li key={file.path} className="flex items-center justify-between gap-2 px-3 py-1">
                <code className="min-w-0 break-all text-ui-sm">{file.path}</code>
                <AgentFileOpenButton path={file.path} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
