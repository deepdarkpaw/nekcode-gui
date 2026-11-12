/** Explicit batch routing choices; the import dialog owns the unsaved values. */
import { useId } from "react";
import { NEK_ENDPOINT_APIS, type NekProviderView } from "@zcode/shared/nek-protocol";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { Field } from "../../components/Field.js";
import { Segmented } from "../../components/inputs.js";
import { BaseUrlPreview } from "../../components/BaseUrlPreview.js";

export function ModelImportEndpoints({
  provider,
  api,
  baseUrl,
  baseUrlInvalid,
  onApiChange,
  onBaseUrlChange,
}: {
  provider: NekProviderView;
  api: string;
  baseUrl: string;
  baseUrlInvalid: boolean;
  onApiChange(value: string): void;
  onBaseUrlChange(value: string): void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const baseUrlId = useId();
  const canInherit = Boolean(provider.api.trim()) || provider.overridesBuiltin;
  return (
    <div className="flex flex-col gap-3 pb-3">
      <Field
        label={t("settings.nek.fetch.api")}
        hint={t("settings.nek.fetch.apiHint")}
        required={!canInherit}
      >
        <Segmented
          value={api || (canInherit ? "inherit" : "")}
          options={[
            ...(canInherit
              ? [
                  {
                    value: "inherit",
                    label: t(
                      provider.api.trim()
                        ? "settings.nek.modelEditor.apiInherit"
                        : "settings.nek.modelEditor.apiBuiltin",
                    ),
                  },
                ]
              : []),
            ...NEK_ENDPOINT_APIS.map((value) => ({
              value,
              label: t(`settings.nek.provider.api.${value}`),
            })),
          ]}
          ariaLabel={t("settings.nek.fetch.api")}
          onChange={(value) => onApiChange(value === "inherit" ? "" : value)}
        />
      </Field>
      <Field
        label={t("settings.nek.modelEditor.baseUrl")}
        htmlFor={baseUrlId}
        hint={t("settings.nek.modelEditor.baseUrlHint")}
        error={baseUrlInvalid ? t("settings.nek.provider.error.baseUrlInvalid") : undefined}
      >
        <Input
          {...TECHNICAL_INPUT_ATTRIBUTES}
          id={baseUrlId}
          value={baseUrl}
          placeholder={provider.baseUrl}
          aria-invalid={baseUrlInvalid || undefined}
          onChange={(event) => onBaseUrlChange(event.target.value)}
        />
        <BaseUrlPreview
          api={api || provider.api}
          value={baseUrl.trim() || provider.baseUrl}
          onFix={onBaseUrlChange}
        />
      </Field>
    </div>
  );
}
