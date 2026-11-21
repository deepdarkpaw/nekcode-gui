import { ActionTooltip } from "@/components/ui/action-tooltip.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { SaveStatusIndicator } from "@/components/ui/setting-fields.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CliModelScopeEditor } from "../api/useCliModelScope.js";

export function ModelScopeCheckbox({
  editor,
  modelRef,
}: {
  editor: CliModelScopeEditor;
  modelRef: string;
}) {
  const { intl } = useZCodeIntl();
  const { included, available } = editor.membership;
  const checked = included.has(modelRef);
  const last = checked && included.size === 1;
  const reason = !editor.data
    ? "settings.nek.scoped.notLoaded"
    : !available.has(modelRef)
      ? "settings.nek.scoped.unavailable"
      : last
        ? "settings.nek.scoped.keepOne"
        : undefined;
  const label = intl.formatMessage({ id: "settings.nek.scoped.modelLabel" }, { model: modelRef });
  const disabledReason = reason ? intl.formatMessage({ id: reason }) : undefined;
  return (
    <ActionTooltip disabled={Boolean(disabledReason)} disabledReason={disabledReason}>
      <Checkbox
        aria-label={label}
        title={disabledReason}
        checked={editor.data ? checked : "indeterminate"}
        disabled={Boolean(reason) || editor.save.state.status === "pending"}
        onCheckedChange={(value) => editor.toggle([modelRef], value === true)}
      />
    </ActionTooltip>
  );
}

export function ModelScopeSaveFeedback({ editor }: { editor: CliModelScopeEditor }) {
  const { state } = editor.save;
  return state.status === "error" ? (
    <p role="alert" className="break-words text-ui-sm text-destructive">
      {state.message}
    </p>
  ) : (
    <SaveStatusIndicator state={state} />
  );
}
