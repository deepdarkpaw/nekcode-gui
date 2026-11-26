import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useServices } from "@/hooks/useServices.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { ModelSelect } from "@/settings/nek/components/modelControls.js";
import { formatModelRef } from "@/settings/nek/lib/modelRef.js";

/** Read and write through this dialog's Git host, including when it is remote. */
export function GitCommitModelField({
  workspacePath,
  disabled,
  onSaving,
}: {
  workspacePath: string;
  disabled: boolean;
  onSaving: (saving: boolean) => void;
}) {
  const { gitService, modelSelectionService } = useServices();
  const { intl } = useZCodeIntl();
  const id = useId();
  const title = intl.formatMessage({ id: "git.commitModel.label" });
  const { state, reload } = useModelSelectionServiceView(
    modelSelectionService,
    true,
    "missing-target",
    { workspacePath, selection: null },
  );
  const [value, setValue] = useState<string | null>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setValue(undefined);
    setError("");
    void gitService.getCommitMessageModel().then(
      (model) => {
        if (current) setValue(model ? formatModelRef(model.providerId, model.modelId) : null);
      },
      (cause) => {
        if (current) setError(getErrorMessage(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [gitService, revision]);
  const models =
    state.status === "ready"
      ? state.view.providers.flatMap((p) =>
          p.models.map((m) => ({ provider: p.providerId, id: m.modelId, name: m.displayName })),
        )
      : [];
  async function save(next?: string) {
    const model = next ? models.find((m) => formatModelRef(m.provider, m.id) === next) : null;
    if (next && !model) return;
    onSaving(true);
    setError("");
    try {
      await gitService.setCommitMessageModel(
        model ? { providerId: model.provider, modelId: model.id } : null,
      );
      setValue(next ?? null);
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      onSaving(false);
    }
  }
  const issue = error || (state.status === "error" ? state.error.message : "");
  return (
    <div className="px-4 pb-3">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="shrink-0 text-ui-sm text-foreground-subtle">
          {title}
        </label>
        <ModelSelect
          id={id}
          ariaLabel={title}
          className="w-auto max-w-64"
          models={models}
          value={value ?? undefined}
          disabled={disabled || state.status !== "ready" || value === undefined}
          unsetLabel={intl.formatMessage({
            id: value === undefined && !issue ? "common.loading" : "git.commitModel.default",
          })}
          onChange={(next) => void save(next)}
        />
      </div>
      {issue && (
        <div role="alert" className="mt-1 flex items-center gap-2 text-ui-sm text-destructive">
          <span className="min-w-0 break-words">{issue}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setRevision((v) => v + 1);
              reload();
            }}
          >
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      )}
    </div>
  );
}
