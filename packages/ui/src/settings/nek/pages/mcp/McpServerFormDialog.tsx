import type { NekConfigRevision as NekDraftRevision } from "@zcode/shared/nek-protocol";
import type { NekDocument } from "../../api/useNekDocument.js";
import { useDialogDraft } from "../../components/useDialogDraft.js";
/**
 * MCP 服务器表单：stdio 填 command / args / env / cwd；HTTP 填 url / headers，OAuth 在高级里。
 * 底部可"测试"当前草稿（连接、列出工具、断开）。
 */
import { useEffect, useId, useMemo, useState } from "react";
import { PlugIcon } from "lucide-react";
import type { NekMcpServerConfig } from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Input } from "@/components/ui/input.js";
import { SettingAdvancedGroup } from "@/components/ui/setting-fields.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { useNekConfigApi, useNekTarget } from "../../api/NekSettingsContext.js";
import {
  emptyMcpDraft,
  mcpDraftFromConfig,
  mcpTransportOf,
  MCP_EXPOSURES,
  resolveMcpDraft,
  type McpFormDraft,
  type McpTransport,
} from "../../lib/mcpForm.js";
import { Field, invalidProps } from "../../components/Field.js";
import { KeyValueEditor, Segmented } from "../../components/inputs.js";
import { NekFormDialog } from "../../components/NekFormDialog.js";
import { McpOAuthFields } from "./McpOAuthFields.js";

function draftKey(draft: McpFormDraft) {
  return JSON.stringify({
    ...draft,
    env: draft.env.map((row) => [row.key, row.value]),
    headers: draft.headers.map((row) => [row.key, row.value]),
  });
}

export function McpServerFormDialog({
  open,
  onOpenChange,
  initial,
  existingNames,
  onSave,
  documents,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** undefined = 新建。 */
  initial?: { name: string; config: NekMcpServerConfig };
  existingNames: ReadonlySet<string>;
  onSave: (name: string, config: NekMcpServerConfig) => Promise<void>;
  documents?: ReadonlyArray<
    Pick<NekDocument<NekDraftRevision>, "setDirty" | "resetToken"> | undefined
  >;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const api = useNekConfigApi();
  const { target } = useNekTarget();
  const baseId = useId();
  const start = useMemo(
    () => (initial ? mcpDraftFromConfig(initial.name, initial.config) : emptyMcpDraft()),
    [initial],
  );
  const [draft, setDraft, resetDraft] = useDialogDraft(open, start);
  const [testResult, setTestResult] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setTestResult(null);
    }
  }, [open]);
  const others = useMemo(
    () => new Set([...existingNames].filter((name) => name !== initial?.name)),
    [existingNames, initial],
  );
  const { errors, config } = resolveMcpDraft(
    draft,
    others,
    t,
    initial ? { config: initial.config, draft: start } : undefined,
  );
  const transport = draft.transport || (initial ? mcpTransportOf(initial.config) : "stdio");
  const advancedErrors = Boolean(
    errors.timeout ||
    errors.exposure ||
    errors.toolExposure ||
    Object.keys(errors).some((field) => field.startsWith("oauth")),
  );
  const update = (patch: Partial<McpFormDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const id = (name: string) => `${baseId}-${name}`;

  return (
    <NekFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(initial ? "settings.nek.mcp.form.editTitle" : "settings.nek.mcp.form.addTitle")}
      dirty={draftKey(draft) !== draftKey(start)}
      valid={Boolean(config)}
      saveLabel={t(initial ? "settings.nek.mcp.form.save" : "settings.nek.mcp.form.add")}
      onSave={() => onSave(draft.name, config!)}
      documents={documents}
      onReset={resetDraft}
      footerStart={
        <>
          <AsyncButton
            variant="outline"
            icon={<PlugIcon />}
            disabled={!config}
            disabledReason={Object.values(errors)[0] ?? t("settings.nek.mcp.form.testDisabled")}
            onClick={async () => {
              if (!config) return;
              setTestResult(null);
              const result = await api.testMcpServer(target, { config });
              if (!result.ok) throw new Error(result.message);
              setTestResult(
                t("settings.nek.mcp.testOk", { ms: result.latencyMs, count: result.tools.length }),
              );
            }}
          >
            {t("settings.nek.mcp.test")}
          </AsyncButton>
          {testResult ? (
            <span role="status" className="text-ui-sm text-success">
              {testResult}
            </span>
          ) : null}
        </>
      }
    >
      {({ attempted }) => {
        const show = (field: keyof typeof errors, value?: string) =>
          attempted || initial || value ? errors[field] : undefined;
        return (
          <>
            <Field
              label={t("settings.nek.mcp.form.name")}
              htmlFor={id("name")}
              required
              error={show("name", draft.name)}
            >
              <Input
                {...TECHNICAL_INPUT_ATTRIBUTES}
                id={id("name")}
                required
                value={draft.name}
                className="font-mono"
                {...invalidProps(id("name"), show("name", draft.name))}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>
            <Field label={t("settings.nek.mcp.form.transport")} error={errors.type}>
              <Segmented<McpTransport | "">
                ariaLabel={t("settings.nek.mcp.form.transport")}
                value={draft.transport}
                options={[
                  { value: "stdio", label: t("settings.nek.mcp.transport.stdio") },
                  { value: "http", label: t("settings.nek.mcp.transport.http") },
                ]}
                onChange={(transport) => update({ transport })}
              />
            </Field>
            {transport === "stdio" ? (
              <>
                <Field
                  label={t("settings.nek.mcp.form.command")}
                  htmlFor={id("command")}
                  required
                  error={show("command")}
                >
                  <Input
                    {...TECHNICAL_INPUT_ATTRIBUTES}
                    id={id("command")}
                    required
                    value={draft.command ?? ""}
                    placeholder="npx"
                    className="font-mono"
                    {...invalidProps(id("command"), show("command"))}
                    onChange={(event) => update({ command: event.target.value })}
                  />
                </Field>
                <Field
                  label={t("settings.nek.mcp.form.args")}
                  htmlFor={id("args")}
                  hint={t("settings.nek.mcp.form.argsHint")}
                  error={errors.args}
                >
                  <Textarea
                    {...TECHNICAL_INPUT_ATTRIBUTES}
                    id={id("args")}
                    value={draft.args}
                    placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
                    className="min-h-16 font-mono"
                    {...invalidProps(id("args"), errors.args)}
                    onChange={(event) => update({ args: event.target.value })}
                  />
                </Field>
                <Field label={t("settings.nek.mcp.form.env")} error={errors.env}>
                  <KeyValueEditor
                    rows={draft.env}
                    secretValues
                    keyPlaceholder={t("settings.nek.kv.envName")}
                    valuePlaceholder={t("settings.nek.kv.value")}
                    addLabel={t("settings.nek.kv.addEnv")}
                    onChange={(env) => update({ env })}
                  />
                </Field>
                <Field
                  label={t("settings.nek.mcp.form.cwd")}
                  htmlFor={id("cwd")}
                  error={errors.cwd}
                >
                  <Input
                    {...TECHNICAL_INPUT_ATTRIBUTES}
                    id={id("cwd")}
                    value={draft.cwd}
                    className="font-mono"
                    {...invalidProps(id("cwd"), errors.cwd)}
                    onChange={(event) => update({ cwd: event.target.value })}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field
                  label={t("settings.nek.mcp.form.url")}
                  htmlFor={id("url")}
                  required
                  error={show("url", draft.url)}
                >
                  <Input
                    {...TECHNICAL_INPUT_ATTRIBUTES}
                    id={id("url")}
                    required
                    value={draft.url}
                    placeholder="https://mcp.example.com/mcp"
                    className="font-mono"
                    {...invalidProps(id("url"), show("url", draft.url))}
                    onChange={(event) => update({ url: event.target.value })}
                  />
                </Field>
                <Field label={t("settings.nek.mcp.form.headers")} error={errors.headers}>
                  {errors.auth ? (
                    <p role="alert" className="text-ui-sm text-destructive">
                      {errors.auth}
                    </p>
                  ) : null}
                  <KeyValueEditor
                    rows={draft.headers}
                    keyPlaceholder={t("settings.nek.kv.headerName")}
                    valuePlaceholder={t("settings.nek.kv.value")}
                    addLabel={t("settings.nek.kv.addHeader")}
                    onChange={(headers) => update({ headers })}
                  />
                </Field>
              </>
            )}
            <Field
              label={t("settings.nek.mcp.form.description")}
              htmlFor={id("description")}
              error={errors.description}
            >
              <Input
                id={id("description")}
                value={draft.description}
                {...invalidProps(id("description"), errors.description)}
                onChange={(event) => update({ description: event.target.value })}
              />
            </Field>
            {errors.enabled ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {errors.enabled}
              </p>
            ) : null}
            <SettingAdvancedGroup defaultOpen={advancedErrors}>
              <div className="flex flex-col gap-4 pt-1">
                <Field
                  label={t("settings.nek.mcp.exposure")}
                  hint={t("settings.nek.mcp.exposureHint")}
                  error={errors.exposure}
                >
                  <Segmented
                    ariaLabel={t("settings.nek.mcp.exposure")}
                    value={draft.exposure}
                    options={MCP_EXPOSURES.map((value) => ({
                      value,
                      label: t(`settings.nek.mcp.exposure.${value}`),
                    }))}
                    onChange={(exposure) => update({ exposure })}
                  />
                </Field>
                {errors.toolExposure ? (
                  <p role="alert" className="text-ui-sm text-destructive">
                    {errors.toolExposure}
                  </p>
                ) : null}
                <Field
                  label={t("settings.nek.mcp.timeout")}
                  htmlFor={id("timeout")}
                  error={errors.timeout}
                  hint={t("settings.nek.mcp.timeoutHint")}
                >
                  <Input
                    id={id("timeout")}
                    inputMode="decimal"
                    value={draft.timeout}
                    placeholder="60"
                    className="w-32 font-mono"
                    {...invalidProps(id("timeout"), errors.timeout)}
                    onChange={(event) => update({ timeout: event.target.value })}
                  />
                </Field>
                {transport === "http" ? (
                  <McpOAuthFields
                    id={id("oauth")}
                    draft={draft.oauth}
                    errors={errors}
                    onChange={(oauth) => update({ oauth })}
                  />
                ) : null}
              </div>
            </SettingAdvancedGroup>
          </>
        );
      }}
    </NekFormDialog>
  );
}
