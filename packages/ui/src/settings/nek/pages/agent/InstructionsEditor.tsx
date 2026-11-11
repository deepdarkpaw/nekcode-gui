/**
 * AGENTS.md 编辑器：显式保存（Ctrl/⌘+S 或按钮），可还原；有未保存改动时登记 dirty，
 * 外部修改改为显示横幅而不是覆盖草稿；"重新载入"会丢弃草稿。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { NekConfigScope } from "@zcode/shared/nek-protocol";
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
import { DocumentBanners, DocumentGate } from "../../components/DocumentStatus.js";

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
  // undefined 表示未编辑：异步读取与 clean watch 直接显示文档，不创建虚假的空草稿。
  const [draft, setDraft] = useState<string>();
  const value = draft ?? saved;
  const dirty = value !== saved;
  useEffect(() => {
    // 正文只由真实读回确认；失败或保存期间的新编辑不能被早先的成功结果清掉。
    setDraft((current) => (current === saved ? undefined : current));
  }, [saved]);
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
      title={title}
      description={doc.data ? <span className="font-mono">{doc.data.path}</span> : undefined}
    >
      <DocumentBanners documents={[doc]} />
      <DocumentGate documents={[doc]}>
        {() => (
          <div className="flex flex-col gap-2">
            <Textarea
              aria-label={title}
              value={value}
              className="min-h-48 font-mono"
              onChange={(event) =>
                setDraft(event.target.value === saved ? undefined : event.target.value)
              }
              onKeyDown={handleKeyDown}
            />
            <div className="flex items-center justify-end gap-2">
              {dirty ? (
                <span className="mr-auto text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.nek.instructions.unsaved" })}
                </span>
              ) : null}
              <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(undefined)}>
                {intl.formatMessage({ id: "settings.nek.instructions.revert" })}
              </Button>
              <div ref={saveButtonRef}>
                <AsyncButton
                  variant="secondary"
                  disabled={!dirty}
                  disabledReason={intl.formatMessage({ id: "settings.nek.instructions.noChanges" })}
                  shortcut={formatActionBindingLabel("CmdOrCtrl+s")}
                  label={intl.formatMessage({ id: "settings.nek.instructions.save" })}
                  onClick={() => doc.save(value)}
                >
                  {intl.formatMessage({ id: "settings.nek.instructions.save" })}
                </AsyncButton>
              </div>
            </div>
          </div>
        )}
      </DocumentGate>
    </SettingSection>
  );
}
