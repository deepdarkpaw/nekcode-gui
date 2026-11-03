import type { NekConfigRevision as NekDraftRevision } from "@zcode/shared/nek-protocol";
import type { NekDocument } from "../../api/useNekDocument.js";
import { useDialogDraft } from "../../components/useDialogDraft.js";
/**
 * 新建 / 编辑服务商表单：
 * 名称 → ID 自动生成（新建时可改，编辑时只读，"修改 ID"走单独的影响预览）；端点类型分段控件；
 * Base URL 占位示例 + 最终请求地址 + 常见错误一键修正；API Key 掩码 / 显示 / 环境变量；
 * 高级（默认折叠）：自定义请求头、authHeader、compat。
 */
import { useId, useMemo, useState } from "react";
import { WandSparklesIcon, ZapIcon } from "lucide-react";
import type { NekEndpointApi, NekProviderView } from "@zcode/shared/nek-protocol";
import { NEK_ENDPOINT_APIS } from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { SettingAdvancedGroup } from "@/components/ui/setting-fields.js";
import { Switch } from "@/components/ui/switch.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { useNekConfigApi, useNekTarget } from "../../api/NekSettingsContext.js";
import { analyzeBaseUrl, BASE_URL_PLACEHOLDERS, type BaseUrlIssue } from "../../lib/baseUrl.js";
import { ApiKeyField } from "../../components/ApiKeyField.js";
import { Field, invalidProps } from "../../components/Field.js";
import { KeyValueEditor, Segmented } from "../../components/inputs.js";
import { NekFormDialog } from "../../components/NekFormDialog.js";
import {
  draftEndpointApi,
  emptyProviderDraft,
  isProviderDraftDirty,
  providerDraftFromView,
  requestDraftFromDraft,
  THINKING_FORMATS,
  validateProviderDraft,
  withName,
  type ProviderDraft,
} from "./providerDraft.js";

/** 分段控件里“不在服务商上设置端点”的取值（Radix 单选把空串当成未选中，不能直接用 ""）。 */
const API_UNSET = "per-model" as const;

function BaseUrlPreview({
  api,
  value,
  onFix,
}: {
  api: NekEndpointApi;
  value: string;
  onFix: (fixed: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const analysis = analyzeBaseUrl(api, value);
  if (analysis.kind !== "ok") {
    return null;
  }
  const issue: BaseUrlIssue | null = analysis.issue;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.nek.provider.finalUrl" })}{" "}
        <span className="break-all font-mono text-foreground">{analysis.finalUrl}</span>
      </p>
      {issue ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/10 px-2 py-1.5">
          <span className="text-ui-sm text-foreground">
            {intl.formatMessage(
              { id: `settings.nek.provider.baseUrlIssue.${issue.kind}` },
              {
                suffix: "suffix" in issue ? issue.suffix : "",
                version: "version" in issue ? issue.version : "",
              },
            )}
          </span>
          <Button type="button" size="sm" variant="secondary" onClick={() => onFix(issue.fixed)}>
            <WandSparklesIcon aria-hidden="true" />
            {intl.formatMessage({ id: "settings.nek.provider.applyFix" }, { url: issue.fixed })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 用当前草稿测一次连接：`{providerId, draft}` —— 已保存的密钥 + 草稿里的其他字段，
 * 所以改完 baseUrl / headers 不必先保存也能知道能不能通。
 */
function TestDraftConnection({
  provider,
  draft,
}: {
  provider: NekProviderView;
  draft: ProviderDraft;
}) {
  const { intl } = useZCodeIntl();
  const api = useNekConfigApi();
  const { target } = useNekTarget();
  const [result, setResult] = useState<string | null>(null);
  const modelId = provider.models[0]?.id;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <AsyncButton
          type="button"
          variant="outline"
          icon={<ZapIcon />}
          disabled={!modelId}
          disabledReason={intl.formatMessage({ id: "settings.nek.provider.test.needModel" })}
          successFeedback="none"
          onClick={async () => {
            if (!modelId) return;
            setResult(null);
            const outcome = await api.testProvider(
              target,
              { providerId: provider.id, draft: requestDraftFromDraft(draft) },
              modelId,
            );
            if (!outcome.ok) throw new Error(outcome.message);
            setResult(
              intl.formatMessage(
                { id: "settings.nek.provider.test.ok" },
                { ms: outcome.latencyMs },
              ),
            );
          }}
        >
          {intl.formatMessage({ id: "settings.nek.provider.test.draftRun" })}
        </AsyncButton>
        {modelId ? (
          <span className="font-mono text-ui-xs text-foreground-subtle">{modelId}</span>
        ) : null}
      </div>
      {result ? (
        <p role="status" className="text-ui-sm text-success">
          {result}
        </p>
      ) : null}
    </div>
  );
}

export function ProviderFormDialog({
  open,
  onOpenChange,
  provider,
  existingIds,
  onSave,
  onRequestRename,
  documents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** undefined = 新建。 */
  provider?: NekProviderView;
  existingIds: ReadonlySet<string>;
  onSave: (draft: ProviderDraft) => Promise<void>;
  onRequestRename?: () => void;
  documents?: ReadonlyArray<
    Pick<NekDocument<NekDraftRevision>, "setDirty" | "resetToken"> | undefined
  >;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const baseId = useId();
  const isNew = provider === undefined;
  const initial = useMemo(
    () => (provider ? providerDraftFromView(provider) : emptyProviderDraft()),
    [provider],
  );
  const [draft, setDraft, resetDraft] = useDialogDraft(open, initial);

  const errors = validateProviderDraft(draft, { isNew, existingIds }, t);
  const valid = Object.keys(errors).length === 0;
  const dirty = isProviderDraftDirty(draft, initial);
  const update = (patch: Partial<ProviderDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const ids = {
    name: `${baseId}-name`,
    id: `${baseId}-id`,
    baseUrl: `${baseId}-base-url`,
    apiKey: `${baseId}-api-key`,
    compat: `${baseId}-compat`,
  };

  return (
    <NekFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(
        isNew ? "settings.nek.provider.form.addTitle" : "settings.nek.provider.form.editTitle",
      )}
      description={t("settings.nek.provider.form.description")}
      dirty={dirty}
      valid={valid}
      saveLabel={t(isNew ? "settings.nek.provider.form.add" : "settings.nek.provider.form.save")}
      onSave={() => onSave(draft)}
      documents={documents}
      onReset={resetDraft}
    >
      {({ attempted }) => {
        const show = (field: keyof typeof errors, touched: boolean) =>
          attempted || touched ? errors[field] : undefined;
        return (
          <>
            <Field
              label={t("settings.nek.provider.field.name")}
              htmlFor={ids.name}
              required
              error={show("name", false)}
            >
              <Input
                id={ids.name}
                required
                value={draft.name}
                placeholder="DeepSeek"
                {...invalidProps(ids.name, show("name", false))}
                onChange={(event) => setDraft((current) => withName(current, event.target.value))}
              />
            </Field>
            <Field
              label={t("settings.nek.provider.field.id")}
              htmlFor={ids.id}
              required={isNew}
              error={show("id", draft.idTouched && draft.id !== "")}
              hint={t(
                isNew
                  ? "settings.nek.provider.field.idHint"
                  : "settings.nek.provider.field.idReadonly",
              )}
              trailing={
                !isNew && onRequestRename ? (
                  <Button type="button" variant="link" size="xs" onClick={onRequestRename}>
                    {t("settings.nek.provider.renameId")}
                  </Button>
                ) : null
              }
            >
              <Input
                {...TECHNICAL_INPUT_ATTRIBUTES}
                id={ids.id}
                value={draft.id}
                readOnly={!isNew}
                required={isNew}
                className="font-mono"
                {...invalidProps(ids.id, show("id", draft.idTouched && draft.id !== ""))}
                onChange={(event) => update({ id: event.target.value, idTouched: true })}
              />
            </Field>
            <Field label={t("settings.nek.provider.field.api")}>
              <Segmented<NekEndpointApi | typeof API_UNSET>
                ariaLabel={t("settings.nek.provider.field.api")}
                value={draft.api || API_UNSET}
                options={[
                  // 原本没在服务商上设置端点（每个模型自带 api）时保留“不设置”，保存不会凭空写入。
                  ...(initial.api === ""
                    ? [{ value: API_UNSET, label: t("settings.nek.provider.api.unset") }]
                    : []),
                  ...NEK_ENDPOINT_APIS.map((api) => ({
                    value: api,
                    label: t(`settings.nek.provider.api.${api}`),
                  })),
                ]}
                onChange={(api) => update({ api: api === API_UNSET ? "" : api })}
              />
            </Field>
            <Field
              label={t("settings.nek.provider.field.baseUrl")}
              htmlFor={ids.baseUrl}
              required
              error={show("baseUrl", draft.baseUrl !== "")}
            >
              <Input
                {...TECHNICAL_INPUT_ATTRIBUTES}
                id={ids.baseUrl}
                required
                value={draft.baseUrl}
                placeholder={BASE_URL_PLACEHOLDERS[draftEndpointApi(draft)]}
                className="font-mono"
                {...invalidProps(ids.baseUrl, show("baseUrl", draft.baseUrl !== ""))}
                onChange={(event) => update({ baseUrl: event.target.value })}
              />
              <BaseUrlPreview
                api={draftEndpointApi(draft)}
                value={draft.baseUrl}
                onFix={(baseUrl) => update({ baseUrl })}
              />
            </Field>
            <Field
              label={t("settings.nek.provider.field.apiKey")}
              htmlFor={ids.apiKey}
              error={show("apiKey", true)}
              hint={t("settings.nek.provider.field.apiKeyHint")}
            >
              <ApiKeyField
                id={ids.apiKey}
                draft={draft.apiKey}
                maskedExisting={
                  provider?.apiKey.kind === "literal" ? provider.apiKey.masked : undefined
                }
                canRemove={(provider?.apiKey.kind ?? "none") !== "none"}
                invalid={Boolean(errors.apiKey)}
                placeholder="sk-..."
                onChange={(apiKey) => update({ apiKey })}
              />
            </Field>
            {provider ? (
              <Field
                label={t("settings.nek.provider.field.test")}
                hint={t("settings.nek.provider.field.testHint")}
              >
                <TestDraftConnection provider={provider} draft={draft} />
              </Field>
            ) : null}
            <SettingAdvancedGroup>
              <div className="flex flex-col gap-4 pt-1">
                <Field label={t("settings.nek.provider.field.headers")} error={errors.headers}>
                  <KeyValueEditor
                    rows={draft.headers}
                    keyPlaceholder={t("settings.nek.kv.headerName")}
                    valuePlaceholder={t("settings.nek.kv.value")}
                    addLabel={t("settings.nek.kv.addHeader")}
                    onChange={(headers) => update({ headers })}
                  />
                </Field>
                <label className="flex items-center justify-between gap-4">
                  <span className="flex flex-col">
                    <span className="text-ui-sm font-medium">
                      {t("settings.nek.provider.field.authHeader")}
                    </span>
                    <span className="text-ui-sm text-foreground-subtle">
                      {t("settings.nek.provider.field.authHeaderHint")}
                    </span>
                  </span>
                  <Switch
                    checked={draft.authHeader}
                    onCheckedChange={(authHeader) => update({ authHeader })}
                  />
                </label>
                {draftEndpointApi(draft) === "openai-completions" ? (
                  <Field
                    label={t("settings.nek.provider.field.thinkingFormat")}
                    hint={t("settings.nek.provider.field.thinkingFormatHint")}
                  >
                    <Segmented
                      ariaLabel={t("settings.nek.provider.field.thinkingFormat")}
                      value={draft.thinkingFormat || "default"}
                      options={[
                        {
                          value: "default",
                          label: t("settings.nek.provider.thinkingFormat.default"),
                        },
                        ...THINKING_FORMATS.map((format) => ({ value: format, label: format })),
                      ]}
                      onChange={(value) =>
                        update({ thinkingFormat: value === "default" ? "" : value })
                      }
                    />
                  </Field>
                ) : null}
                <Field
                  label={t("settings.nek.provider.field.compat")}
                  htmlFor={ids.compat}
                  error={errors.compatJson}
                  hint={t("settings.nek.provider.field.compatHint")}
                >
                  <Textarea
                    {...TECHNICAL_INPUT_ATTRIBUTES}
                    id={ids.compat}
                    value={draft.compatJson}
                    placeholder='{ "supportsDeveloperRole": false }'
                    className="min-h-20 font-mono"
                    {...invalidProps(ids.compat, errors.compatJson)}
                    onChange={(event) => update({ compatJson: event.target.value })}
                  />
                </Field>
              </div>
            </SettingAdvancedGroup>
          </>
        );
      }}
    </NekFormDialog>
  );
}
