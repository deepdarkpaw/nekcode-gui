/**
 * 修改服务商 ID（高级）：输入新 ID → 预览并同步改写 defaultProvider、enabledModels、compaction.model、
 * modelThinkingLevels 与子代理预设里的引用；删除服务商：确认框列出删除后会失效的引用。
 */
import { useEffect, useId, useState } from "react";
import { LoaderIcon } from "lucide-react";
import type { NekProviderReferences, NekProviderView } from "@zcode/shared/nek-protocol";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { useNekConfigApi, useNekTarget } from "../../api/NekSettingsContext.js";
import { toNekConfigApiError } from "../../api/nekErrors.js";
import { validateProviderId } from "../../lib/providerId.js";
import { Field, invalidProps } from "../../components/Field.js";
import { NekConfirmDialog } from "../../components/NekConfirmDialog.js";
import { NekFormDialog } from "../../components/NekFormDialog.js";

export function countReferences(references: NekProviderReferences): number {
  return (
    Number(references.defaultModel) +
    references.enabledModels.length +
    Number(references.compactionModel) +
    references.modelThinkingLevels.length +
    references.agentPresets.length
  );
}

export function ReferenceList({ references }: { references: NekProviderReferences | null }) {
  const { intl } = useZCodeIntl();
  if (!references) {
    return (
      <p role="status" className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
        <LoaderIcon className="size-3.5 animate-spin" aria-hidden="true" />
        {intl.formatMessage({ id: "settings.nek.provider.refs.loading" })}
      </p>
    );
  }
  if (countReferences(references) === 0) {
    return (
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.nek.provider.refs.none" })}
      </p>
    );
  }
  const items: string[] = [
    ...(references.defaultModel
      ? [intl.formatMessage({ id: "settings.nek.provider.refs.defaultModel" })]
      : []),
    ...references.enabledModels.map((ref) =>
      intl.formatMessage({ id: "settings.nek.provider.refs.enabledModel" }, { ref }),
    ),
    ...(references.compactionModel
      ? [intl.formatMessage({ id: "settings.nek.provider.refs.compaction" })]
      : []),
    ...references.modelThinkingLevels.map((ref) =>
      intl.formatMessage({ id: "settings.nek.provider.refs.thinking" }, { ref }),
    ),
    ...references.agentPresets.map((preset) =>
      intl.formatMessage({ id: "settings.nek.provider.refs.preset" }, { name: preset.name }),
    ),
  ];
  return (
    <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-xl bg-surface px-3 py-2">
      {items.map((item) => (
        <li key={item} className="text-ui-sm text-foreground">
          {item}
        </li>
      ))}
    </ul>
  );
}

function useReferences(open: boolean, providerId: string) {
  const api = useNekConfigApi();
  const { target } = useNekTarget();
  const [references, setReferences] = useState<NekProviderReferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setReferences(null);
    setError(null);
    api.getProviderReferences(target, providerId).then(
      (result) => !cancelled && setReferences(result),
      (cause: unknown) => !cancelled && setError(toNekConfigApiError(cause).message),
    );
    return () => {
      cancelled = true;
    };
  }, [open, api, target, providerId]);
  return { references, error };
}

export function DeleteProviderDialog({
  open,
  onOpenChange,
  provider,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: NekProviderView;
  onConfirm: () => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const { references, error } = useReferences(open, provider.id);
  return (
    <NekConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={intl.formatMessage(
        { id: "settings.nek.provider.delete.title" },
        { name: provider.name ?? provider.id },
      )}
      description={intl.formatMessage(
        { id: "settings.nek.provider.delete.description" },
        { count: provider.models.length },
      )}
      confirmLabel={intl.formatMessage({ id: "settings.nek.provider.delete.confirm" })}
      destructive
      onConfirm={onConfirm}
    >
      <div className="flex flex-col gap-1.5">
        <p className="text-ui-sm font-medium text-foreground">
          {intl.formatMessage({ id: "settings.nek.provider.refs.brokenTitle" })}
        </p>
        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        ) : (
          <ReferenceList references={references} />
        )}
      </div>
    </NekConfirmDialog>
  );
}

export function RenameProviderDialog({
  open,
  onOpenChange,
  provider,
  existingIds,
  onRename,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: NekProviderView;
  existingIds: ReadonlySet<string>;
  onRename: (to: string) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const inputId = useId();
  const [next, setNext] = useState(provider.id);
  useEffect(() => {
    if (open) setNext(provider.id);
  }, [open, provider.id]);
  const { references } = useReferences(open, provider.id);
  const idError = next === provider.id ? "unchanged" : validateProviderId(next, existingIds);
  const errorText =
    idError === null || idError === "unchanged"
      ? undefined
      : intl.formatMessage({ id: `settings.nek.provider.error.id.${idError}` });
  return (
    <NekFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={intl.formatMessage({ id: "settings.nek.provider.rename.title" })}
      description={intl.formatMessage({ id: "settings.nek.provider.rename.description" })}
      dirty={next !== provider.id}
      valid={idError === null}
      saveLabel={intl.formatMessage({ id: "settings.nek.provider.renameId" })}
      onSave={() => onRename(next)}
    >
      {({ attempted }) => (
        <>
          <Field
            label={intl.formatMessage({ id: "settings.nek.provider.rename.newId" })}
            htmlFor={inputId}
            required
            error={attempted || next !== provider.id ? errorText : undefined}
            hint={intl.formatMessage(
              { id: "settings.nek.provider.rename.from" },
              { id: provider.id },
            )}
          >
            <Input
              {...TECHNICAL_INPUT_ATTRIBUTES}
              id={inputId}
              value={next}
              className="font-mono"
              {...invalidProps(inputId, errorText)}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setNext(event.target.value)}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <p className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "settings.nek.provider.refs.rewriteTitle" })}
            </p>
            <ReferenceList references={references} />
          </div>
        </>
      )}
    </NekFormDialog>
  );
}
