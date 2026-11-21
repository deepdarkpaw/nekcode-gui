import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { IconButton } from "@/components/ui/icon-button.js";
import { SettingSection } from "@/components/ui/setting-fields.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCliModelScope, type CliModelScopeEditor } from "../api/useCliModelScope.js";
import { DiagnosticsList, DocumentGate } from "../components/DocumentStatus.js";
import { ModelScopeCheckbox, ModelScopeSaveFeedback } from "../components/ModelScopeControls.js";
import { SortableList } from "../components/SortableList.js";
import { formatModelRef, groupModelsByProvider } from "../lib/modelRef.js";

function ScopePatternList({ editor }: { editor: CliModelScopeEditor }) {
  const { intl } = useZCodeIntl();
  const patterns = editor.data?.scope.patterns ?? [];
  const countByPattern = new Map<string, number>();
  const patternById = new Map(
    patterns.map((pattern) => {
      const occurrence = countByPattern.get(pattern) ?? 0;
      countByPattern.set(pattern, occurrence + 1);
      return [JSON.stringify([pattern, occurrence]), pattern] as const;
    }),
  );
  const pending = editor.save.state.status === "pending";
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-card-border bg-card p-3">
      <h4 className="text-ui-sm font-medium text-foreground">
        {intl.formatMessage(
          { id: "settings.nek.scoped.selected" },
          { count: editor.membership.included.size },
        )}
      </h4>
      {patterns.length === 0 ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.nek.scoped.allModels" })}
        </p>
      ) : (
        <>
          <SortableList
            ids={[...patternById.keys()]}
            dragLabel={intl.formatMessage({ id: "settings.nek.model.dragLabel" })}
            onReorder={(ids) => {
              if (!pending) void editor.save.run(ids.map((id) => patternById.get(id)!));
            }}
            renderItem={(id, index) => (
              <div className="flex items-center gap-2 py-1">
                <span className="min-w-0 flex-1 truncate font-mono text-ui-sm">
                  {patternById.get(id)}
                </span>
                <IconButton
                  size="icon-sm"
                  label={intl.formatMessage({ id: "settings.nek.scoped.remove" })}
                  disabled={patterns.length === 1 || pending}
                  disabledReason={intl.formatMessage({
                    id:
                      patterns.length === 1
                        ? "settings.nek.scoped.useAllHint"
                        : "settings.nek.load.loading",
                  })}
                  onClick={() =>
                    void editor.save.run(patterns.filter((_ref, position) => position !== index))
                  }
                >
                  <XIcon />
                </IconButton>
              </div>
            )}
          />
          <Button
            className="self-start"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => void editor.save.run([])}
          >
            {intl.formatMessage({ id: "settings.nek.scoped.useAll" })}
          </Button>
        </>
      )}
    </div>
  );
}

function ScopeMembershipList({ editor }: { editor: CliModelScopeEditor }) {
  const { intl } = useZCodeIntl();
  const { included } = editor.membership;
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-card-border bg-card p-3">
      {groupModelsByProvider(editor.data?.available ?? []).map(({ provider, models }) => {
        const refs = models.map((model) => formatModelRef(provider, model.id));
        const allChecked = refs.every((ref) => included.has(ref));
        return (
          <fieldset key={provider} className="flex flex-col gap-1">
            <legend className="flex w-full items-center justify-between">
              <span className="text-ui-sm font-medium text-foreground">{provider}</span>
              <Button
                variant="ghost"
                size="xs"
                title={
                  allChecked && included.size === refs.length
                    ? intl.formatMessage({ id: "settings.nek.scoped.keepOne" })
                    : undefined
                }
                disabled={
                  editor.save.state.status === "pending" ||
                  (allChecked && included.size === refs.length)
                }
                onClick={() => editor.toggle(refs, !allChecked)}
              >
                {intl.formatMessage({
                  id: allChecked
                    ? "settings.nek.scoped.selectNone"
                    : "settings.nek.scoped.selectAll",
                })}
              </Button>
            </legend>
            {models.map((model) => {
              const ref = formatModelRef(provider, model.id);
              return (
                <label
                  key={ref}
                  className="flex items-center gap-2 rounded-md px-1 py-0.5 text-ui-sm hover:bg-hover"
                >
                  <ModelScopeCheckbox editor={editor} modelRef={ref} />
                  <span className="min-w-0 flex-1 truncate">{model.name || model.id}</span>
                  <span className="truncate font-mono text-ui-xs text-foreground-subtlest">
                    {model.id}
                  </span>
                </label>
              );
            })}
          </fieldset>
        );
      })}
    </div>
  );
}

export function ScopedModelsSection() {
  const { intl } = useZCodeIntl();
  const editor = useCliModelScope();
  return (
    <SettingSection
      title={intl.formatMessage({ id: "settings.nek.scoped.title" })}
      description={intl.formatMessage({ id: "settings.nek.scoped.description" })}
    >
      <DocumentGate documents={[editor.query]}>
        {() => (
          <>
            <ModelScopeSaveFeedback editor={editor} />
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.nek.scoped.exclusionHint" })}
            </p>
            <DiagnosticsList
              diagnostics={editor.data?.scope.diagnostics.map(({ message, pattern }) => ({
                file: `enabledModels · ${pattern}`,
                message,
                severity: "warning",
              }))}
            />
            <div className="grid gap-4 md:grid-cols-2">
              <ScopePatternList editor={editor} />
              <ScopeMembershipList editor={editor} />
            </div>
          </>
        )}
      </DocumentGate>
    </SettingSection>
  );
}
