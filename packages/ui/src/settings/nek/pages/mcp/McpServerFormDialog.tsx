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
  mcpConfigFromDraft,
  mcpDraftFromConfig,
  MCP_EXPOSURES,
  validateMcpDraft,
  type McpFormDraft,
  type McpTransport,
} from "../../lib/mcpForm.js";
import { Field, invalidProps } from "../../components/Field.js";
import { KeyValueEditor, Segmented } from "../../components/inputs.js";
import { NekFormDialog } from "../../components/NekFormDialog.js";

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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** undefined = 新建。 */
  initial?: { name: string; config: NekMcpServerConfig };
  existingNames: ReadonlySet<string>;
  onSave: (name: string, config: NekMcpServerConfig) => Promise<void>;
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
  const [draft, setDraft] = useState(start);
  const [testResult, setTestResult] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setDraft(start);
      setTestResult(null);
    }
  }, [open, start]);
  const others = useMemo(
    () => new Set([...existingNames].filter((name) => name !== initial?.name)),
    [existingNames, initial],
  );
  const errors = validateMcpDraft(draft, others, t);
  const valid = Object.keys(errors).length === 0;
  const update = (patch: Partial<McpFormDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const id = (name: string) => `${baseId}-${name}`;

  return (
    <NekFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t(initial ? "settings.nek.mcp.form.editTitle" : "settings.nek.mcp.form.addTitle")}
      dirty={draftKey(draft) !== draftKey(start)}
      valid={valid}
      saveLabel={t(initial ? "settings.nek.mcp.form.save" : "settings.nek.mcp.form.add")}
      onSave={() => onSave(draft.name.trim(), mcpConfigFromDraft(draft))}
      footerStart={
        <>
          <AsyncButton
            variant="outline"
            icon={<PlugIcon />}
            disabled={!valid}
            disabledReason={t("settings.nek.mcp.form.testDisabled")}
            onClick={async () => {
              setTestResult(null);
              const result = await api.testMcpServer(target, { config: mcpConfigFromDraft(draft) });
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
        const show = (field: keyof typeof errors) => (attempted ? errors[field] : undefined);
        return (
          <>
            <Field
              label={t("settings.nek.mcp.form.name")}
              htmlFor={id("name")}
              required
              error={show("name") ?? (draft.name ? errors.name : undefined)}
            >
              <Input
                {...TECHNICAL_INPUT_ATTRIBUTES}
                id={id("name")}
                required
                value={draft.name}
                className="font-mono"
                {...invalidProps(
                  id("name"),
                  show("name") ?? (draft.name ? errors.name : undefined),
                )}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>
            <Field label={t("settings.nek.mcp.form.transport")}>
              <Segmented<McpTransport>
                ariaLabel={t("settings.nek.mcp.form.transport")}
                value={draft.transport}
                options={[
                  { value: "stdio", label: t("settings.nek.mcp.transport.stdio") },
                  { value: "http", label: t("settings.nek.mcp.transport.http") },
                ]}
                onChange={(transport) => update({ transport })}
              />
            </Field>
            {draft.transport === "stdio" ? (
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
                    value={draft.command}
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
                >
                  <Textarea
                    {...TECHNICAL_INPUT_ATTRIBUTES}
                    id={id("args")}
                    value={draft.args}
                    placeholder={"-y\n@modelcontextprotocol/server-filesystem"}
                    className="min-h-16 font-mono"
                    onChange={(event) => update({ args: event.target.value })}
                  />
                </Field>
                <Field label={t("settings.nek.mcp.form.env")}>
                  <KeyValueEditor
                    rows={draft.env}
                    secretValues
                    keyPlaceholder={t("settings.nek.kv.envName")}
                    valuePlaceholder={t("settings.nek.kv.value")}
                    addLabel={t("settings.nek.kv.addEnv")}
                    onChange={(env) => update({ env })}
                  />
                </Field>
                <Field label={t("settings.nek.mcp.form.cwd")} htmlFor={id("cwd")}>
                  <Input
                    {...TECHNICAL_INPUT_ATTRIBUTES}
                    id={id("cwd")}
                    value={draft.cwd}
                    className="font-mono"
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
                  error={show("url")}
                >
                  <Input
                    {...TECHNICAL_INPUT_ATTRIBUTES}
                    id={id("url")}
                    required
                    value={draft.url}
                    placeholder="https://mcp.example.com/mcp"
                    className="font-mono"
                    {...invalidProps(id("url"), show("url"))}
                    onChange={(event) => update({ url: event.target.value })}
                  />
                </Field>
                <Field label={t("settings.nek.mcp.form.headers")}>
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
            <Field label={t("settings.nek.mcp.form.description")} htmlFor={id("description")}>
              <Input
                id={id("description")}
                value={draft.description}
                onChange={(event) => update({ description: event.target.value })}
              />
            </Field>
            <SettingAdvancedGroup>
              <div className="flex flex-col gap-4 pt-1">
                <Field
                  label={t("settings.nek.mcp.exposure")}
                  hint={t("settings.nek.mcp.exposureHint")}
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
                <Field
                  label={t("settings.nek.mcp.timeout")}
                  htmlFor={id("timeout")}
                  error={show("timeout") ?? errors.timeout}
                  hint={t("settings.nek.mcp.timeoutHint")}
                >
                  <Input
                    id={id("timeout")}
                    inputMode="numeric"
                    value={draft.timeout}
                    placeholder="60"
                    className="w-32 font-mono"
                    {...invalidProps(id("timeout"), errors.timeout)}
                    onChange={(event) => update({ timeout: event.target.value })}
                  />
                </Field>
                {draft.transport === "http" ? (
                  <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1 text-ui-sm font-medium">
                      {t("settings.nek.mcp.form.oauth")}
                    </legend>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        aria-label="clientId"
                        placeholder="clientId"
                        value={draft.oauth.clientId}
                        className="font-mono"
                        onChange={(event) =>
                          update({ oauth: { ...draft.oauth, clientId: event.target.value } })
                        }
                      />
                      <Input
                        aria-label="clientSecret"
                        type="password"
                        placeholder="clientSecret"
                        value={draft.oauth.clientSecret}
                        className="font-mono"
                        onChange={(event) =>
                          update({ oauth: { ...draft.oauth, clientSecret: event.target.value } })
                        }
                      />
                      <Input
                        aria-label="callbackPort"
                        placeholder="callbackPort"
                        inputMode="numeric"
                        value={draft.oauth.callbackPort}
                        className="font-mono"
                        {...invalidProps(id("port"), errors.callbackPort)}
                        onChange={(event) =>
                          update({ oauth: { ...draft.oauth, callbackPort: event.target.value } })
                        }
                      />
                      <Input
                        aria-label="scope"
                        placeholder="scope"
                        value={draft.oauth.scope}
                        className="font-mono"
                        onChange={(event) =>
                          update({ oauth: { ...draft.oauth, scope: event.target.value } })
                        }
                      />
                    </div>
                    {errors.callbackPort ? (
                      <p role="alert" className="text-ui-sm text-destructive">
                        {errors.callbackPort}
                      </p>
                    ) : null}
                  </fieldset>
                ) : null}
              </div>
            </SettingAdvancedGroup>
          </>
        );
      }}
    </NekFormDialog>
  );
}
