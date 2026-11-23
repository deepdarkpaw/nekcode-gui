/**
 * 子代理预设列表（来源：内置 / 用户 / 项目）：新建、编辑、复制、删除（撤销）。
 * 内置预设只读，可复制为用户预设。Agent 页显示全部，项目页只显示项目预设。
 */
import { useState } from "react";
import { CopyPlusIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type {
  NekAgentPresetEntry,
  NekCatalogModel,
  NekConfigScope,
} from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
import { IconButton } from "@/components/ui/icon-button.js";
import { SettingSection } from "@/components/ui/setting-fields.js";
import { useUndoToast } from "@/components/ui/undo-toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { NekAgentPresetsDocument } from "../../api/mcpDocs.js";
import { DocumentGate } from "../../components/DocumentStatus.js";
import { handleRowArrowNavigation } from "../../components/SortableList.js";
import { AgentFileOpenButton } from "./AgentFileOpenButton.js";
import { AgentPresetDialog } from "./AgentPresetDialog.js";

type FilePreset = Extract<NekAgentPresetEntry, { path: string }>;

type Dialog =
  | { kind: "none" }
  | { kind: "new" }
  | { kind: "edit"; entry: FilePreset }
  | { kind: "copy"; entry: NekAgentPresetEntry };

function scopeOf(entry: NekAgentPresetEntry): NekConfigScope {
  return entry.source === "project" ? "project" : "global";
}

export function AgentPresetsSection({
  doc,
  models,
  sources,
  allowProjectScope,
  title,
}: {
  doc: NekAgentPresetsDocument;
  models: readonly NekCatalogModel[];
  sources: ReadonlyArray<NekAgentPresetEntry["source"]>;
  allowProjectScope: boolean;
  title: string;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const showUndo = useUndoToast();
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const entries = (doc.data?.entries ?? []).filter((entry) => sources.includes(entry.source));
  const diagnostics = doc.data?.diagnostics ?? [];
  const edited =
    dialog.kind === "edit" &&
    (entries.find((entry) => entry.path === dialog.entry.path) ?? dialog.entry);

  // Delay the real deletion during the existing undo window. Undo never recreates or rewrites a file.
  const remove = (entry: FilePreset) =>
    new Promise<void>((resolve, reject) => {
      showUndo({
        message: t("settings.nek.agent.preset.pendingDelete", { name: entry.preset.name }),
        onUndo: resolve,
        onExpire: () => void doc.deletePreset(scopeOf(entry), entry).then(resolve, reject),
      });
    });

  return (
    <SettingSection title={title} description={t("settings.nek.agent.presetsHint")}>
      <div className="flex justify-end">
        <Button variant="outline" onClick={() => setDialog({ kind: "new" })}>
          <PlusIcon aria-hidden="true" />
          {t("settings.nek.agent.preset.new")}
        </Button>
      </div>
      <DocumentGate documents={[doc]}>
        {() => (
          <>
            {diagnostics.length ? (
              <div className="flex flex-col gap-2" role="status">
                <p className="text-ui-sm font-medium text-destructive">
                  {t("settings.nek.agent.preset.diagnostics")}
                </p>
                <ul className="flex flex-col divide-y divide-border rounded-xl border border-card-border bg-card">
                  {diagnostics.map(({ file, message }, index) => (
                    <li
                      key={`${file}:${index}`}
                      className="flex items-start justify-between gap-3 px-3 py-2"
                    >
                      <div className="min-w-0 space-y-1">
                        <p className="break-all font-mono text-ui-sm">{file}</p>
                        <p className="break-words text-ui-sm text-foreground-subtle">
                          {message.startsWith(`${file}: `)
                            ? message.slice(file.length + 2)
                            : message}
                        </p>
                      </div>
                      <AgentFileOpenButton path={file} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {entries.length === 0 ? (
              <p className="text-ui-sm text-foreground-subtle">
                {t("settings.nek.agent.preset.empty")}
              </p>
            ) : (
              <div
                data-nek-list=""
                className="flex flex-col rounded-xl border border-card-border bg-card"
              >
                {entries.map((entry) => (
                  <div
                    key={entry.path ?? `builtin:${entry.preset.name}`}
                    data-nek-row=""
                    tabIndex={0}
                    onKeyDown={handleRowArrowNavigation}
                    className="flex items-center gap-3 border-b border-border px-3 py-2 outline-none last:border-b-0 focus-visible:bg-hover"
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="break-all font-mono text-ui-base text-foreground">
                          {entry.preset.name}
                        </span>
                        <span className="rounded-sm bg-tag px-1 text-ui-xs text-foreground-subtle">
                          {t(`settings.nek.agent.source.${entry.source}`)}
                        </span>
                        {entry.preset.model ? (
                          <span className="truncate font-mono text-ui-xs text-foreground-subtlest">
                            {entry.preset.model}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-ui-sm text-foreground-subtle">
                        {entry.preset.description}
                      </span>
                      {entry.path ? (
                        <span className="break-all font-mono text-ui-sm text-foreground-subtlest">
                          {entry.path}
                        </span>
                      ) : null}
                      {entry.overriddenBy ? (
                        <span className="break-words text-ui-sm text-foreground-subtle">
                          {t("settings.nek.agent.preset.overridden", { path: entry.overriddenBy })}
                        </span>
                      ) : null}
                      {entry.untrusted ? (
                        <span className="text-ui-sm text-foreground-subtle">
                          {t("settings.nek.agent.preset.untrusted")}
                        </span>
                      ) : null}
                      <span className="break-words text-ui-sm text-foreground-subtle">
                        {t("settings.nek.agent.preset.effectiveTools", {
                          tools:
                            entry.effectiveTools.join(", ") ||
                            t("settings.nek.agent.preset.noTools"),
                        })}
                      </span>
                    </div>
                    {entry.source !== "builtin" ? (
                      <IconButton
                        size="icon-sm"
                        label={t("settings.nek.agent.preset.edit")}
                        onClick={() => setDialog({ kind: "edit", entry })}
                      >
                        <PencilIcon />
                      </IconButton>
                    ) : null}
                    <IconButton
                      size="icon-sm"
                      label={t("settings.nek.agent.preset.duplicate")}
                      onClick={() => setDialog({ kind: "copy", entry })}
                    >
                      <CopyPlusIcon />
                    </IconButton>
                    {entry.source !== "builtin" ? (
                      <AsyncButton
                        size="icon-sm"
                        variant="ghost"
                        label={t("settings.nek.agent.preset.delete")}
                        icon={<Trash2Icon />}
                        successFeedback="none"
                        onClick={() => remove(entry)}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </DocumentGate>
      <AgentPresetDialog
        documents={[doc]}
        editing={dialog.kind === "edit"}
        open={dialog.kind !== "none"}
        onOpenChange={(open) => !open && setDialog({ kind: "none" })}
        initial={
          dialog.kind === "edit"
            ? (edited || dialog.entry).preset
            : dialog.kind === "copy"
              ? { ...dialog.entry.preset, name: `${dialog.entry.preset.name}-copy` }
              : undefined
        }
        scope={
          dialog.kind === "edit"
            ? scopeOf(dialog.entry)
            : sources.includes("project") && !sources.includes("user")
              ? "project"
              : undefined
        }
        allowProjectScope={allowProjectScope}
        models={models}
        onSave={(scope, preset) =>
          doc.savePreset(scope, preset, dialog.kind === "edit" ? dialog.entry.path : undefined)
        }
      />
    </SettingSection>
  );
}
