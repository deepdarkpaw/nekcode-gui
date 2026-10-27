import type { NekConfigRevision as NekDraftRevision } from "@zcode/shared/nek-protocol";
import type { NekDocument } from "../../api/useNekDocument.js";
import { useDialogDraft } from "../../components/useDialogDraft.js";
/**
 * 子代理预设表单：name、description、model、thinking、context_window、readonly、tools、
 * disallowed_tools、is_background、autonomous 与正文说明。
 */
import { useId, useMemo } from "react";
import type { NekAgentPreset, NekCatalogModel, NekConfigScope } from "@zcode/shared/nek-protocol";
import { NEK_THINKING_LEVELS } from "@zcode/shared/nek-protocol";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { findCatalogModel, supportedThinkingLevels } from "../../lib/modelRef.js";
import { Field, invalidProps } from "../../components/Field.js";
import { Segmented, TokenCountInput } from "../../components/inputs.js";
import { ModelSelect, ThinkingLevelSelect } from "../../components/modelControls.js";
import { NekFormDialog } from "../../components/NekFormDialog.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

interface PresetDraft {
  scope: NekConfigScope;
  preset: NekAgentPreset;
  tools: string;
  disallowed: string;
  contextValid: boolean;
}

function splitList(text: string): string[] | undefined {
  const items = text
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function presetFromDraft(draft: PresetDraft): NekAgentPreset {
  const preset: NekAgentPreset = {
    ...draft.preset,
    name: draft.preset.name.trim(),
    description: draft.preset.description.trim(),
    tools: splitList(draft.tools),
    disallowedTools: splitList(draft.disallowed),
  };
  return Object.fromEntries(
    Object.entries(preset).filter(([, value]) => value !== undefined && value !== false),
  ) as NekAgentPreset;
}

export function AgentPresetDialog({
  open,
  onOpenChange,
  initial,
  scope,
  allowProjectScope,
  takenNames,
  models,
  onSave,
  editing,
  documents,
}: {
  /** 编辑已有预设（否则为新建 / 复制）。 */
  editing: boolean;
  documents?: ReadonlyArray<
    Pick<NekDocument<NekDraftRevision>, "setDirty" | "resetToken"> | undefined
  >;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 编辑或复制的来源；undefined 为新建。 */
  initial?: NekAgentPreset;
  /** 编辑时固定作用域；新建 / 复制时可选。 */
  scope?: NekConfigScope;
  allowProjectScope: boolean;
  takenNames: (scope: NekConfigScope) => ReadonlySet<string>;
  models: readonly NekCatalogModel[];
  onSave: (scope: NekConfigScope, preset: NekAgentPreset) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const baseId = useId();
  const start = useMemo<PresetDraft>(
    () => ({
      scope: scope ?? "global",
      preset: initial ?? { name: "", description: "", instructions: "" },
      tools: initial?.tools?.join(", ") ?? "",
      disallowed: initial?.disallowedTools?.join(", ") ?? "",
      contextValid: true,
    }),
    [initial, scope],
  );
  const [draft, setDraft, resetDraft] = useDialogDraft(open, start);
  const preset = draft.preset;
  const update = (patch: Partial<NekAgentPreset>) =>
    setDraft((current) => ({ ...current, preset: { ...current.preset, ...patch } }));
  const name = preset.name.trim();
  const nameError =
    name === ""
      ? t("settings.nek.agent.preset.error.nameRequired")
      : !NAME_PATTERN.test(name)
        ? t("settings.nek.agent.preset.error.nameFormat")
        : takenNames(draft.scope).has(name)
          ? t("settings.nek.agent.preset.error.nameDuplicate")
          : undefined;
  const descriptionError =
    preset.description.trim() === ""
      ? t("settings.nek.agent.preset.error.descriptionRequired")
      : undefined;
  const valid = !nameError && !descriptionError && draft.contextValid;
  const levels = preset.model
    ? supportedThinkingLevels(findCatalogModel(models, preset.model))
    : [...NEK_THINKING_LEVELS];
  const id = (field: string) => `${baseId}-${field}`;

  return (
    <NekFormDialog
      open={open}
      onOpenChange={onOpenChange}
      variant="drawer"
      title={t(
        editing ? "settings.nek.agent.preset.editTitle" : "settings.nek.agent.preset.addTitle",
      )}
      dirty={JSON.stringify(draft) !== JSON.stringify(start)}
      valid={valid}
      saveLabel={t(editing ? "settings.nek.agent.preset.save" : "settings.nek.agent.preset.create")}
      onSave={() => onSave(draft.scope, presetFromDraft(draft))}
      documents={documents}
      onReset={resetDraft}
    >
      {({ attempted }) => (
        <>
          {!editing && allowProjectScope ? (
            <Field label={t("settings.nek.agent.preset.scope")}>
              <Segmented<NekConfigScope>
                ariaLabel={t("settings.nek.agent.preset.scope")}
                value={draft.scope}
                options={[
                  { value: "global", label: t("settings.nek.agent.source.user") },
                  { value: "project", label: t("settings.nek.agent.source.project") },
                ]}
                onChange={(next) => setDraft((current) => ({ ...current, scope: next }))}
              />
            </Field>
          ) : null}
          <Field
            label={t("settings.nek.agent.preset.name")}
            htmlFor={id("name")}
            required
            error={attempted || name ? nameError : undefined}
          >
            <Input
              {...TECHNICAL_INPUT_ATTRIBUTES}
              id={id("name")}
              required
              value={preset.name}
              className="font-mono"
              {...invalidProps(id("name"), attempted || name ? nameError : undefined)}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          <Field
            label={t("settings.nek.agent.preset.description")}
            htmlFor={id("description")}
            required
            error={attempted ? descriptionError : undefined}
          >
            <Input
              id={id("description")}
              required
              value={preset.description}
              {...invalidProps(id("description"), attempted ? descriptionError : undefined)}
              onChange={(event) => update({ description: event.target.value })}
            />
          </Field>
          <Field label={t("settings.nek.agent.preset.model")}>
            <ModelSelect
              ariaLabel={t("settings.nek.agent.preset.model")}
              value={preset.model}
              models={models}
              unsetLabel={t("settings.nek.agent.preset.inherit")}
              onChange={(model) => update({ model })}
            />
          </Field>
          <Field label={t("settings.nek.agent.preset.thinking")}>
            <ThinkingLevelSelect
              ariaLabel={t("settings.nek.agent.preset.thinking")}
              value={preset.thinking}
              levels={levels}
              unsetLabel={t("settings.nek.agent.preset.inherit")}
              onChange={(thinking) => update({ thinking })}
            />
          </Field>
          <Field
            label={t("settings.nek.agent.preset.contextWindow")}
            htmlFor={id("ctx")}
            hint={t("settings.nek.modelEditor.tokensHint")}
          >
            <TokenCountInput
              id={id("ctx")}
              value={preset.contextWindow}
              onChange={(contextWindow, contextValid) =>
                setDraft((current) => ({
                  ...current,
                  contextValid,
                  preset: { ...current.preset, contextWindow },
                }))
              }
            />
          </Field>
          <Field
            label={t("settings.nek.agent.preset.tools")}
            htmlFor={id("tools")}
            hint={t("settings.nek.agent.preset.toolsHint")}
          >
            <Input
              {...TECHNICAL_INPUT_ATTRIBUTES}
              id={id("tools")}
              value={draft.tools}
              className="font-mono"
              placeholder="read, grep, find"
              onChange={(event) =>
                setDraft((current) => ({ ...current, tools: event.target.value }))
              }
            />
          </Field>
          <Field label={t("settings.nek.agent.preset.disallowedTools")} htmlFor={id("disallowed")}>
            <Input
              {...TECHNICAL_INPUT_ATTRIBUTES}
              id={id("disallowed")}
              value={draft.disallowed}
              className="font-mono"
              placeholder="bash, write"
              onChange={(event) =>
                setDraft((current) => ({ ...current, disallowed: event.target.value }))
              }
            />
          </Field>
          {(["readonly", "isBackground", "autonomous"] as const).map((flag) => (
            <label key={flag} className="flex items-center justify-between gap-4">
              <span className="flex flex-col">
                <span className="text-ui-sm font-medium">
                  {t(`settings.nek.agent.preset.${flag}`)}
                </span>
                <span className="text-ui-sm text-foreground-subtle">
                  {t(`settings.nek.agent.preset.${flag}Hint`)}
                </span>
              </span>
              <Switch
                checked={preset[flag] === true}
                onCheckedChange={(checked) => update({ [flag]: checked })}
              />
            </label>
          ))}
          <Field label={t("settings.nek.agent.preset.instructions")} htmlFor={id("instructions")}>
            <Textarea
              id={id("instructions")}
              value={preset.instructions}
              className="min-h-40 font-mono"
              onChange={(event) => update({ instructions: event.target.value })}
            />
          </Field>
        </>
      )}
    </NekFormDialog>
  );
}
