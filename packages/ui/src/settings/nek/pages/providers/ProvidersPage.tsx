/**
 * 服务商与模型：左列服务商列表，右列详情与模型表格；新建/编辑表单、获取模型列表、模型编辑抽屉、
 * 修改 ID 影响预览、删除确认、删除模型 5 s 撤销。
 */
import { useMemo, useState } from "react";
import { BoxesIcon } from "lucide-react";
import type { NekModelConfig, NekProviderView } from "@zcode/shared/nek-protocol";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useUndoToast } from "@/components/ui/undo-toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { useNekTarget } from "../../api/NekSettingsContext.js";
import { useNekModelsDoc, type NekModelsDocument } from "../../api/modelsDoc.js";
import { useNekSettingsDoc, type NekSettingsDocument } from "../../api/settingsDocs.js";
import { formatModelRef } from "../../lib/modelRef.js";
import { DiagnosticsList, DocumentGate, NekEmptyState } from "../../components/DocumentStatus.js";
import { NekPageFrame } from "../../components/NekPageFrame.js";
import { FetchModelsDialog } from "./FetchModelsDialog.js";
import { modelConfigFromDraft } from "./modelDraft.js";
import { ModelEditorDialog } from "./ModelEditorDialog.js";
import { providerWriteFromDraft, type ProviderDraft } from "./providerDraft.js";
import { ProviderDetail } from "./ProviderDetail.js";
import { ProviderFormDialog } from "./ProviderFormDialog.js";
import { DeleteProviderDialog, RenameProviderDialog } from "./ProviderIdDialogs.js";
import { ProviderList } from "./ProviderList.js";

type DialogState =
  | { kind: "none" }
  | { kind: "addProvider" }
  | { kind: "editProvider" }
  | { kind: "rename" }
  | { kind: "delete" }
  | { kind: "fetch" }
  | { kind: "model"; model: NekModelConfig | undefined };

function ProvidersBody({
  models,
  settings,
}: {
  models: NekModelsDocument;
  settings: NekSettingsDocument;
}) {
  const { intl } = useZCodeIntl();
  const showUndo = useUndoToast();
  const { targetKey } = useNekTarget();
  const providers = models.data?.providers ?? [];
  const [selectedId, setSelectedId] = useState<string | undefined>(providers[0]?.id);
  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  const selected = providers.find((provider) => provider.id === selectedId) ?? providers[0];
  const editingModel = dialog.kind === "model" ? dialog.model : undefined;
  const existingIds = useMemo(() => new Set(providers.map((provider) => provider.id)), [providers]);
  const close = () => setDialog({ kind: "none" });
  const values = settings.data?.values ?? {};

  const saveProvider = async (draft: ProviderDraft, isNew: boolean) => {
    await models.saveProvider(providerWriteFromDraft(draft, isNew ? undefined : selected), isNew);
    if (isNew) {
      setSelectedId(draft.id);
      // 新建后直接引导获取模型列表。
      setTimeout(() => setDialog({ kind: "fetch" }), 0);
    }
  };

  const deleteModel = async (provider: NekProviderView, model: NekModelConfig) => {
    const order = provider.models.map((item) => item.id);
    try {
      await models.deleteModel(provider.id, model.id);
    } catch (error) {
      toast(getErrorMessage(error), { variant: "warning" });
      return;
    }
    showUndo({
      message: intl.formatMessage({ id: "settings.nek.model.deleted" }, { id: model.id }),
      onUndo: () => {
        void (async () => {
          await models.addModels(provider.id, [model]);
          await models.reorderModels(provider.id, order);
        })().catch((error: unknown) => toast(getErrorMessage(error), { variant: "warning" }));
      },
    });
  };

  if (!selected) {
    return (
      <>
        <NekEmptyState
          icon={<BoxesIcon className="size-5" aria-hidden="true" />}
          title={intl.formatMessage({ id: "settings.nek.provider.emptyTitle" })}
          description={intl.formatMessage({ id: "settings.nek.provider.emptyDescription" })}
          action={
            <Button onClick={() => setDialog({ kind: "addProvider" })}>
              {intl.formatMessage({ id: "settings.nek.provider.add" })}
            </Button>
          }
        />
        <ProviderFormDialog
          documents={[models]}
          open={dialog.kind === "addProvider"}
          onOpenChange={(open) => !open && close()}
          existingIds={existingIds}
          onSave={(draft) => saveProvider(draft, true)}
        />
      </>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <ProviderList
        providers={providers}
        selectedId={selected.id}
        targetKey={targetKey}
        onSelect={setSelectedId}
        onAdd={() => setDialog({ kind: "addProvider" })}
      />
      <ProviderDetail
        provider={selected}
        defaultModelRef={{ provider: values.defaultProvider, model: values.defaultModel }}
        onEdit={() => setDialog({ kind: "editProvider" })}
        onFetch={() => setDialog({ kind: "fetch" })}
        onRename={() => setDialog({ kind: "rename" })}
        onDelete={() => setDialog({ kind: "delete" })}
        onAddModel={() => setDialog({ kind: "model", model: undefined })}
        onEditModel={(model) => setDialog({ kind: "model", model })}
        onSetDefault={(model) =>
          void settings
            .patch({ defaultProvider: selected.id, defaultModel: model.id })
            .then(() =>
              toast(intl.formatMessage({ id: "settings.nek.model.defaultSet" }, { id: model.id })),
            )
            .catch((error: unknown) => toast(getErrorMessage(error), { variant: "warning" }))
        }
        onDeleteModel={(model) => void deleteModel(selected, model)}
        onReorder={(ids) =>
          void models
            .reorderModels(selected.id, ids)
            .catch((error: unknown) => toast(getErrorMessage(error), { variant: "warning" }))
        }
      />
      <ProviderFormDialog
        documents={[models]}
        open={dialog.kind === "addProvider" || dialog.kind === "editProvider"}
        onOpenChange={(open) => !open && close()}
        provider={dialog.kind === "editProvider" ? selected : undefined}
        existingIds={existingIds}
        onSave={(draft) => saveProvider(draft, dialog.kind === "addProvider")}
        onRequestRename={() => setDialog({ kind: "rename" })}
      />
      <RenameProviderDialog
        documents={[models]}
        open={dialog.kind === "rename"}
        onOpenChange={(open) => !open && close()}
        provider={selected}
        existingIds={existingIds}
        onRename={async (to) => {
          await models.renameProvider(selected.id, to);
          setSelectedId(to);
        }}
      />
      <DeleteProviderDialog
        open={dialog.kind === "delete"}
        onOpenChange={(open) => !open && close()}
        provider={selected}
        onConfirm={async () => {
          await models.deleteProvider(selected.id);
          setSelectedId(undefined);
        }}
      />
      <FetchModelsDialog
        open={dialog.kind === "fetch"}
        onOpenChange={(open) => !open && close()}
        provider={selected}
        onAdd={(added) => models.addModels(selected.id, added)}
        onManualAdd={() => setDialog({ kind: "model", model: undefined })}
      />
      <ModelEditorDialog
        documents={[models]}
        open={dialog.kind === "model"}
        onOpenChange={(open) => !open && close()}
        model={editingModel}
        providerApi={selected.api}
        providerBaseUrl={selected.baseUrl}
        overridesBuiltin={selected.overridesBuiltin}
        defaultLevel={
          editingModel
            ? values.modelThinkingLevels?.[formatModelRef(selected.id, editingModel.id)]
            : undefined
        }
        otherIds={
          new Set(selected.models.map((model) => model.id).filter((id) => id !== editingModel?.id))
        }
        onSave={(draft) =>
          models.saveModel(selected.id, modelConfigFromDraft(draft, editingModel), {
            previousId: editingModel?.id,
            defaultThinkingLevel: draft.defaultLevel ?? null,
          })
        }
      />
    </div>
  );
}

export function ProvidersPage() {
  const { intl } = useZCodeIntl();
  const models = useNekModelsDoc();
  const settings = useNekSettingsDoc();
  return (
    <NekPageFrame
      usesTarget
      description={intl.formatMessage({ id: "settings.nek.provider.pageDescription" })}
      documents={[models, settings]}
    >
      <DocumentGate documents={[models, settings]}>
        {() => (
          <>
            <DiagnosticsList diagnostics={models.data?.diagnostics} />
            <ProvidersBody models={models} settings={settings} />
          </>
        )}
      </DocumentGate>
    </NekPageFrame>
  );
}
