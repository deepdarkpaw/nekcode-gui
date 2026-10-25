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
import { Button } from "@/components/ui/button.js";
import { IconButton } from "@/components/ui/icon-button.js";
import { SettingSection } from "@/components/ui/setting-fields.js";
import { toast } from "@/components/ui/toast.js";
import { useUndoToast } from "@/components/ui/undo-toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import type { NekAgentPresetsDocument } from "../../api/mcpDocs.js";
import { DocumentGate } from "../../components/DocumentStatus.js";
import { handleRowArrowNavigation } from "../../components/SortableList.js";
import { AgentPresetDialog } from "./AgentPresetDialog.js";

type Dialog =
  | { kind: "none" }
  | { kind: "new" }
  | { kind: "edit"; entry: NekAgentPresetEntry }
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
  const takenNames = (scope: NekConfigScope) =>
    new Set(
      (doc.data?.entries ?? [])
        .filter((entry) => scopeOf(entry) === scope && entry.source !== "builtin")
        .filter((entry) => dialog.kind !== "edit" || entry !== dialog.entry)
        .map((entry) => entry.preset.name),
    );

  const remove = (entry: NekAgentPresetEntry) => {
    void doc
      .deletePreset(scopeOf(entry), entry.preset.name)
      .then(() =>
        showUndo({
          message: t("settings.nek.agent.preset.deleted", { name: entry.preset.name }),
          onUndo: () => {
            void doc
              .savePreset(scopeOf(entry), entry.preset)
              .catch((error: unknown) => toast(getErrorMessage(error), { variant: "warning" }));
          },
        }),
      )
      .catch((error: unknown) => toast(getErrorMessage(error), { variant: "warning" }));
  };

  return (
    <SettingSection title={title} description={t("settings.nek.agent.presetsHint")}>
      <div className="flex justify-end">
        <Button variant="outline" onClick={() => setDialog({ kind: "new" })}>
          <PlusIcon aria-hidden="true" />
          {t("settings.nek.agent.preset.new")}
        </Button>
      </div>
      <DocumentGate documents={[doc]}>
        {() =>
          entries.length === 0 ? (
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
                  key={`${entry.source}:${entry.preset.name}`}
                  data-nek-row=""
                  tabIndex={0}
                  onKeyDown={handleRowArrowNavigation}
                  className="flex items-center gap-3 border-b border-border px-3 py-2 outline-none last:border-b-0 focus-visible:bg-hover"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-ui-base text-foreground">
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
                    <span className="truncate text-ui-sm text-foreground-subtle">
                      {entry.preset.description}
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
                    <IconButton
                      size="icon-sm"
                      label={t("settings.nek.agent.preset.delete")}
                      onClick={() => remove(entry)}
                    >
                      <Trash2Icon />
                    </IconButton>
                  ) : null}
                </div>
              ))}
            </div>
          )
        }
      </DocumentGate>
      <AgentPresetDialog
        editing={dialog.kind === "edit"}
        open={dialog.kind !== "none"}
        onOpenChange={(open) => !open && setDialog({ kind: "none" })}
        initial={
          dialog.kind === "edit"
            ? dialog.entry.preset
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
        takenNames={takenNames}
        models={models}
        onSave={(scope, preset) =>
          doc.savePreset(
            scope,
            preset,
            dialog.kind === "edit" ? dialog.entry.preset.name : undefined,
          )
        }
      />
    </SettingSection>
  );
}
