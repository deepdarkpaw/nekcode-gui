import { ServerIcon } from "lucide-react";
import type { RemoteTarget } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { openHostSettings } from "../api/hostSettingsIntent.js";

export function ProjectHostBanner({ target }: { target: RemoteTarget }) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-card-border bg-card p-4">
      <ServerIcon className="size-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-ui-base font-medium">{t("settings.nek.hostProjects.unsavedTitle")}</p>
        <p className="text-ui-sm text-foreground-subtle">
          {t("settings.nek.hostProjects.unsavedDescription")}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => openHostSettings({ target, action: "settings" })}
      >
        {t("settings.nek.hostProjects.saveHost")}
      </Button>
    </div>
  );
}
