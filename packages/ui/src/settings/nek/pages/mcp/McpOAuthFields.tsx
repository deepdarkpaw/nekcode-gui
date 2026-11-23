import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { Field, invalidProps } from "../../components/Field.js";
import { MCP_OAUTH_FIELDS, type McpFormErrors, type McpOauthDraft } from "../../lib/mcpForm.js";

/** OAuth fields use the shared validator's exact field paths. */
export function McpOAuthFields({
  id,
  draft,
  errors,
  onChange,
}: {
  id: string;
  draft: McpOauthDraft;
  errors: McpFormErrors;
  onChange: (next: McpOauthDraft) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-ui-sm font-medium">
        {intl.formatMessage({ id: "settings.nek.mcp.form.oauth" })}
      </legend>
      {[errors.oauth, errors["oauth.clientRegistration"]].filter(Boolean).map((error) => (
        <p key={error} role="alert" className="text-ui-sm text-destructive">
          {error}
        </p>
      ))}
      <div className="grid grid-cols-2 gap-2">
        {MCP_OAUTH_FIELDS.map((field) => {
          const inputId = `${id}-${field}`;
          const error = errors[`oauth.${field}`];
          return (
            <Field
              key={field}
              label={intl.formatMessage({ id: `settings.nek.mcp.form.oauth.${field}` })}
              htmlFor={inputId}
              error={error}
              className={field === "authServerMetadataUrl" ? "col-span-2" : undefined}
            >
              <Input
                {...TECHNICAL_INPUT_ATTRIBUTES}
                id={inputId}
                type={field === "clientSecret" ? "password" : "text"}
                inputMode={field === "callbackPort" ? "numeric" : undefined}
                className="font-mono"
                value={draft[field]}
                {...invalidProps(inputId, error)}
                onChange={(event) => onChange({ ...draft, [field]: event.target.value })}
              />
            </Field>
          );
        })}
      </div>
    </fieldset>
  );
}
