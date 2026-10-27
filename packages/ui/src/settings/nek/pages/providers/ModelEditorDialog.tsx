import type { NekConfigRevision as NekDraftRevision } from "@zcode/shared/nek-protocol";
import type { NekDocument } from "../../api/useNekDocument.js";
import { useDialogDraft } from "../../components/useDialogDraft.js";
/**
 * 模型编辑抽屉：ID、显示名称、上下文窗口与最大输出（支持 `200k` / `1M`）、图片输入、
 * 支持思考 + 可用等级勾选（高级：上游原始取值）、默认思考等级、价格（高级）。
 */
import { useId, useMemo } from "react";
import type { NekModelConfig, NekThinkingLevel } from "@zcode/shared/nek-protocol";
import { NEK_THINKING_LEVELS } from "@zcode/shared/nek-protocol";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import { SettingAdvancedGroup } from "@/components/ui/setting-fields.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { enabledThinkingLevels } from "../../lib/thinkingLevels.js";
import { NEK_DEFAULT_CONTEXT_WINDOW, NEK_DEFAULT_MAX_TOKENS } from "../../lib/fetchedModels.js";
import { Field, invalidProps } from "../../components/Field.js";
import { TokenCountInput } from "../../components/inputs.js";
import { ThinkingLevelSelect, thinkingLevelLabel } from "../../components/modelControls.js";
import { NekFormDialog } from "../../components/NekFormDialog.js";
import {
  COST_FIELDS,
  isModelDraftDirty,
  modelDraftFrom,
  validateModelDraft,
  type ModelDraft,
} from "./modelDraft.js";

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span className="flex flex-col">
        <span className="text-ui-sm font-medium">{label}</span>
        {hint ? <span className="text-ui-sm text-foreground-subtle">{hint}</span> : null}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function ThinkingEditor({
  draft,
  onChange,
}: {
  draft: ModelDraft;
  onChange: (draft: ModelDraft) => void;
}) {
  const { intl } = useZCodeIntl();
  const toggle = (level: NekThinkingLevel, checked: boolean) => {
    const enabled = new Set(draft.thinking.enabled);
    if (checked) enabled.add(level);
    else enabled.delete(level);
    onChange({ ...draft, thinking: { ...draft.thinking, enabled } });
  };
  return (
    <div className="flex flex-col gap-2">
      <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
        <legend className="mb-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.nek.modelEditor.levels" })}
        </legend>
        {NEK_THINKING_LEVELS.map((level) => (
          <label key={level} className="flex items-center gap-1.5 text-ui-sm">
            <Checkbox
              checked={draft.thinking.enabled.has(level)}
              onCheckedChange={(checked) => toggle(level, checked === true)}
            />
            {thinkingLevelLabel(intl, level)}
          </label>
        ))}
      </fieldset>
      <SettingAdvancedGroup
        title={intl.formatMessage({ id: "settings.nek.modelEditor.rawValues" })}
      >
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.nek.modelEditor.rawValuesHint" })}
        </p>
        <div className="grid grid-cols-2 gap-2">
          {NEK_THINKING_LEVELS.filter((level) => draft.thinking.enabled.has(level)).map((level) => (
            <label key={level} className="flex items-center gap-2 text-ui-sm">
              <span className="w-16 shrink-0 text-foreground-subtle">
                {thinkingLevelLabel(intl, level)}
              </span>
              <Input
                {...TECHNICAL_INPUT_ATTRIBUTES}
                value={draft.thinking.raw[level] ?? ""}
                placeholder={intl.formatMessage({ id: "settings.nek.modelEditor.rawDefault" })}
                className="font-mono"
                onChange={(event) =>
                  onChange({
                    ...draft,
                    thinking: {
                      ...draft.thinking,
                      raw: { ...draft.thinking.raw, [level]: event.target.value },
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
      </SettingAdvancedGroup>
    </div>
  );
}

export function ModelEditorDialog({
  open,
  onOpenChange,
  model,
  defaultLevel,
  otherIds,
  onSave,
  documents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** undefined = 手动添加。 */
  model: NekModelConfig | undefined;
  defaultLevel: NekThinkingLevel | undefined;
  otherIds: ReadonlySet<string>;
  onSave: (draft: ModelDraft) => Promise<void>;
  documents?: ReadonlyArray<
    Pick<NekDocument<NekDraftRevision>, "setDirty" | "resetToken"> | undefined
  >;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const baseId = useId();
  const initial = useMemo(() => modelDraftFrom(model, defaultLevel), [model, defaultLevel]);
  const [draft, setDraft, resetDraft] = useDialogDraft(open, initial);
  const errors = validateModelDraft(draft, otherIds, t);
  const update = (patch: Partial<ModelDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const ids = {
    id: `${baseId}-id`,
    name: `${baseId}-name`,
    ctx: `${baseId}-ctx`,
    max: `${baseId}-max`,
    level: `${baseId}-level`,
  };

  return (
    <NekFormDialog
      open={open}
      onOpenChange={onOpenChange}
      variant="drawer"
      title={t(model ? "settings.nek.modelEditor.editTitle" : "settings.nek.modelEditor.addTitle")}
      dirty={isModelDraftDirty(draft, initial)}
      valid={Object.keys(errors).length === 0}
      saveLabel={t(model ? "settings.nek.modelEditor.save" : "settings.nek.modelEditor.add")}
      onSave={() => onSave(draft)}
      documents={documents}
      onReset={resetDraft}
    >
      {({ attempted }) => (
        <>
          <Field
            label={t("settings.nek.modelEditor.id")}
            htmlFor={ids.id}
            required
            error={attempted || draft.id ? errors.id : undefined}
          >
            <Input
              {...TECHNICAL_INPUT_ATTRIBUTES}
              id={ids.id}
              required
              value={draft.id}
              className="font-mono"
              {...invalidProps(ids.id, attempted || draft.id ? errors.id : undefined)}
              onChange={(event) => update({ id: event.target.value })}
            />
          </Field>
          <Field
            label={t("settings.nek.modelEditor.name")}
            htmlFor={ids.name}
            hint={t("settings.nek.modelEditor.nameHint")}
          >
            <Input
              id={ids.name}
              value={draft.name}
              placeholder={draft.id}
              onChange={(event) => update({ name: event.target.value })}
            />
          </Field>
          <Field
            label={t("settings.nek.modelEditor.contextWindow")}
            htmlFor={ids.ctx}
            error={errors.contextWindow}
            hint={t("settings.nek.modelEditor.tokensHint")}
          >
            <TokenCountInput
              id={ids.ctx}
              value={draft.contextWindow}
              placeholder={NEK_DEFAULT_CONTEXT_WINDOW}
              invalid={Boolean(errors.contextWindow)}
              onChange={(contextWindow, contextValid) => update({ contextWindow, contextValid })}
            />
          </Field>
          <Field
            label={t("settings.nek.modelEditor.maxTokens")}
            htmlFor={ids.max}
            error={errors.maxTokens}
          >
            <TokenCountInput
              id={ids.max}
              value={draft.maxTokens}
              placeholder={NEK_DEFAULT_MAX_TOKENS}
              invalid={Boolean(errors.maxTokens)}
              onChange={(maxTokens, maxValid) => update({ maxTokens, maxValid })}
            />
          </Field>
          <SwitchRow
            label={t("settings.nek.modelEditor.image")}
            checked={draft.image}
            onChange={(image) => update({ image })}
          />
          <SwitchRow
            label={t("settings.nek.modelEditor.reasoning")}
            hint={t("settings.nek.modelEditor.reasoningHint")}
            checked={draft.thinking.reasoning}
            onChange={(reasoning) => update({ thinking: { ...draft.thinking, reasoning } })}
          />
          {draft.thinking.reasoning ? <ThinkingEditor draft={draft} onChange={setDraft} /> : null}
          <Field
            label={t("settings.nek.modelEditor.defaultLevel")}
            htmlFor={ids.level}
            error={errors.defaultLevel}
            hint={t("settings.nek.modelEditor.defaultLevelHint")}
          >
            <ThinkingLevelSelect
              id={ids.level}
              value={draft.defaultLevel}
              levels={enabledThinkingLevels(draft.thinking)}
              unsetLabel={t("settings.nek.modelEditor.defaultLevelUnset")}
              invalid={Boolean(errors.defaultLevel)}
              onChange={(defaultLevel) => update({ defaultLevel })}
            />
          </Field>
          <SettingAdvancedGroup title={t("settings.nek.modelEditor.cost")}>
            <p className="text-ui-sm text-foreground-subtle">
              {t("settings.nek.modelEditor.costHint")}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {COST_FIELDS.map((field) => (
                <label key={field} className="flex flex-col gap-1 text-ui-sm">
                  <span className="text-foreground-subtle">
                    {t(`settings.nek.modelEditor.cost.${field}`)}
                  </span>
                  <Input
                    inputMode="decimal"
                    value={draft.cost[field]}
                    aria-invalid={Boolean(errors.cost) || undefined}
                    className="font-mono"
                    onChange={(event) =>
                      update({ cost: { ...draft.cost, [field]: event.target.value } })
                    }
                  />
                </label>
              ))}
            </div>
            {errors.cost ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {errors.cost}
              </p>
            ) : null}
          </SettingAdvancedGroup>
        </>
      )}
    </NekFormDialog>
  );
}
