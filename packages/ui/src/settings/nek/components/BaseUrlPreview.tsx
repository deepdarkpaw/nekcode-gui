/** Shared provider/model request preview. Suggestions only change the unsaved field on click. */
import { WandSparklesIcon } from "lucide-react";
import { NEK_ENDPOINT_APIS, type NekEndpointApi } from "@zcode/shared/nek-protocol";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { analyzeBaseUrl } from "../lib/baseUrl.js";

export function BaseUrlPreview({
  api,
  value,
  modelId,
  onFix,
}: {
  api: string;
  value: string;
  modelId?: string;
  onFix: (fixed: string) => void;
}) {
  const { intl } = useZCodeIntl();
  if (!NEK_ENDPOINT_APIS.includes(api as NekEndpointApi)) return null;
  const analysis = analyzeBaseUrl(api as NekEndpointApi, value, modelId);
  if (analysis.kind !== "ok") return null;
  const issue = analysis.issue;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.nek.provider.finalUrl" })}{" "}
        <span className="break-all font-mono text-foreground">{analysis.finalUrl}</span>
      </p>
      {api === "google-generative-ai" ? (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.nek.modelEditor.geminiRouteHint" })}
        </p>
      ) : null}
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
