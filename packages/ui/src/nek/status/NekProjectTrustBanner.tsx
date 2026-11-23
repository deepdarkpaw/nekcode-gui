import { ShieldOffIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";

/** Persistent status for the actual session, not a prediction from the saved policy. */
export function NekProjectTrustBanner({ projectTrusted }: { projectTrusted?: boolean }) {
  const { intl } = useZCodeIntl();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  if (projectTrusted !== false) return null;
  return (
    <section
      role="status"
      data-status-view="project-trust-banner"
      className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-card-border bg-surface px-3 py-2 text-ui-sm"
    >
      <ShieldOffIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {intl.formatMessage({ id: "nek.conversation.projectUntrusted" })}
      </span>
      <Button
        type="button"
        variant="link"
        size="xs"
        onClick={() => {
          setPendingSettingsSectionIntent("nekProject");
          openSettingsTab();
        }}
      >
        {intl.formatMessage({ id: "nek.conversation.changeProjectTrust" })}
      </Button>
    </section>
  );
}
