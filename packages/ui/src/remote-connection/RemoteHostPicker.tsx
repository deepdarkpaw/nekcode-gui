import { useEffect, useState } from "react";
import { ChevronRight, Plus, Server } from "lucide-react";
import type {
  RemoteTarget,
  RemoteTargetSnapshot,
  RemoteWorkspaceSessionEntry,
  SSHConfigAliasOption,
} from "@zcode/shared";
import { buildRemoteEnvironmentKey, buildSshConnectionKey } from "@zcode/shared";
import type { NekRemoteHost } from "@zcode/shared/nek-protocol";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatRemoteWorkspaceTargetSubtitle } from "@/lib/remoteWorkspaceHistory.js";
import { useNekHostApi } from "@/settings/nek/api/NekSettingsContext.js";
import { getErrorMessage } from "@/lib/errorMessage.js";

export type HostChoice = { label: string; target: RemoteTarget; history?: RemoteTargetSnapshot };

export function savedHostChoice(host: NekRemoteHost): HostChoice {
  const target = host.target;
  return {
    label: host.alias,
    target: target.kind === "ssh" ? { ...target, savedHostId: host.connectionId } : target,
  };
}

/** Keep explicit profiles distinct. Collapse repeated project paths, not different SSH routes. */
export function remoteHostChoices(
  hosts: NekRemoteHost[],
  history: RemoteWorkspaceSessionEntry[],
  aliases: SSHConfigAliasOption[],
): HostChoice[] {
  const choices: HostChoice[] = [];
  const seen = new Set<string>();
  const route = (target: RemoteTargetSnapshot | RemoteTarget, passwordAuth = false) =>
    target.kind === "ssh"
      ? buildSshConnectionKey(passwordAuth ? { ...target, passwordCredentialKey: "saved" } : target)
      : buildRemoteEnvironmentKey(target);
  for (const host of hosts) {
    choices.push(savedHostChoice(host));
    seen.add(route(host.target, host.authMethod === "password"));
  }
  for (const { target } of [...history].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)) {
    const key = route(target);
    if (seen.has(key) || (target.kind === "ssh" && target.savedHostId)) continue;
    seen.add(key);
    choices.push({
      label:
        (target.kind === "ssh" && target.sshConfigAlias) ||
        formatRemoteWorkspaceTargetSubtitle(target),
      target,
      history: target,
    });
  }
  for (const alias of aliases) {
    if (!alias.username) continue; // Incomplete entries can still be selected in the new-host form.
    const target: RemoteTarget = {
      kind: "ssh",
      sshConfigAlias: alias.alias,
      host: alias.host || alias.alias,
      username: alias.username,
      port: alias.port,
      privateKeyPath: alias.privateKeyPath,
    };
    if (!seen.has(route(target))) choices.push({ label: alias.alias, target });
    seen.add(route(target));
  }
  return choices;
}

export function RemoteHostPicker({
  history,
  aliases,
  aliasError,
  loadingAliases,
  windows,
  onChoose,
  onNew,
}: {
  history: RemoteWorkspaceSessionEntry[];
  aliases: SSHConfigAliasOption[];
  aliasError: string;
  loadingAliases: boolean;
  windows: boolean;
  onChoose: (choice: HostChoice) => void;
  onNew: () => void;
}) {
  const api = useNekHostApi();
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const [hosts, setHosts] = useState<NekRemoteHost[] | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setError("");
    void api.listHosts().then(
      (value) => {
        if (current) setHosts(value);
      },
      (cause) => {
        if (current) setError(getErrorMessage(cause));
      },
    );
    const unsubscribe = api.onHostsChanged(() => setRevision((n) => n + 1));
    return () => {
      current = false;
      unsubscribe();
    };
  }, [api, revision]);
  const choices = remoteHostChoices(hosts ?? [], history, aliases).filter(
    ({ target }) => windows || target.kind !== "wsl",
  );
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <div role="alert" className="flex items-center gap-2 text-ui-sm text-destructive">
            {error}
            <Button variant="outline" onClick={() => setRevision((n) => n + 1)}>
              {t("common.retry")}
            </Button>
          </div>
        )}
        {aliasError && (
          <p role="alert" className="text-ui-sm text-destructive">
            {aliasError}
          </p>
        )}
        {!choices.length && !error && (
          <p role="status" className="p-3 text-ui-base text-foreground-subtle">
            {t(hosts === null || loadingAliases ? "common.loading" : "remote.hostPicker.empty")}
          </p>
        )}
        {choices.map((choice, index) => {
          const detail = formatRemoteWorkspaceTargetSubtitle(choice.target);
          return (
            <Button
              key={
                (choice.target.kind === "ssh" && choice.target.savedHostId) || `${index}:${detail}`
              }
              type="button"
              variant="ghost"
              className="h-auto w-full justify-start gap-3 px-3 py-2 text-left"
              onClick={() => onChoose(choice)}
            >
              <Server aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
              <span className="min-w-0 flex-1 whitespace-normal break-words">
                <span className="block text-ui-base font-medium">{choice.label}</span>
                {detail !== choice.label && (
                  <span className="block font-mono text-ui-sm text-foreground-subtle">
                    {detail}
                  </span>
                )}
              </span>
              <span className="text-ui-sm text-foreground-subtle">{t("remote.connect")}</span>
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          );
        })}
      </div>
      <div className="border-t border-border pt-3">
        <Button type="button" variant="outline" onClick={onNew}>
          <Plus aria-hidden="true" />
          {t("remote.hostPicker.new")}
        </Button>
      </div>
    </div>
  );
}
