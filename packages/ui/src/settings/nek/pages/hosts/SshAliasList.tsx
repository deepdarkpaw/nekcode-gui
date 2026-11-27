import { PlusIcon, TerminalIcon } from "lucide-react";
import type { SSHConfigAliasOption } from "@zcode/shared";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
import { useSshConfigAliases } from "@/hooks/useSshConfigAliases.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { sshConfigAliasTarget } from "@/remote-connection/RemoteHostPicker.js";
import { useNekHostApi, useNekTarget } from "../../api/NekSettingsContext.js";
import type { NekRemoteHost } from "../../api/hostApi.js";

export function SshAliasList({
  hosts,
  edit,
}: {
  hosts: NekRemoteHost[];
  edit: (alias: SSHConfigAliasOption) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id: `settings.nek.hostProjects.${id}` });
  const api = useNekHostApi();
  const { refreshTargets } = useNekTarget();
  const { aliases, error, loading, reload } = useSshConfigAliases(true);
  const savedAliases = new Set(
    hosts.flatMap(({ target }) =>
      target.kind === "ssh" && target.sshConfigAlias ? [target.sshConfigAlias] : [],
    ),
  );
  const available = aliases.filter((alias) => !savedAliases.has(alias.alias));
  if (!available.length && !error && !loading) return null;
  return (
    <section aria-label={t("sshAliases")} className="flex flex-col gap-3">
      <div className="space-y-1">
        <h3 className="text-ui-base font-medium">{t("sshAliases")}</h3>
        <p className="text-ui-sm text-foreground-subtle">{t("sshAliasesDescription")}</p>
      </div>
      {loading ? (
        <p role="status" className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "common.loading" })}
        </p>
      ) : null}
      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
          <Button variant="outline" size="sm" onClick={reload}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}
      {available.length ? (
        <ul className="divide-y divide-border rounded-xl border border-card-border bg-card">
          {available.map((option) => {
            const target = sshConfigAliasTarget(option);
            return (
              <li key={option.alias} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <TerminalIcon
                  className="size-4 shrink-0 text-foreground-subtle"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-ui-base font-medium">{option.alias}</p>
                  <p className="break-words font-mono text-ui-sm text-foreground-subtle">
                    {option.username ? `${option.username}@` : ""}
                    {option.host || option.alias}:{option.port ?? 22}
                  </p>
                </div>
                {target ? (
                  <AsyncButton
                    variant="outline"
                    size="sm"
                    icon={<PlusIcon />}
                    onClick={async () => {
                      await api.saveHost({ alias: option.alias, target });
                      await refreshTargets();
                    }}
                  >
                    {t("saveHost")}
                  </AsyncButton>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => edit(option)}>
                    {t("completeAlias")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
