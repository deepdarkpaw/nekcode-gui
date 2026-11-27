import { FolderIcon, ArrowUpRightIcon } from "lucide-react";
import { matchSavedRemoteHost, type RemoteWorkspaceSessionEntry } from "@zcode/shared";
import { AsyncButton } from "@/components/ui/async-button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildWorkspaceSessionKey } from "@/lib/remoteWorkspaceHistory.js";
import type { NekRemoteHost } from "../../api/hostApi.js";

export function groupHostProjects(hosts: NekRemoteHost[], projects: RemoteWorkspaceSessionEntry[]) {
  const byHost = new Map<string, RemoteWorkspaceSessionEntry[]>();
  for (const project of projects) {
    const host = matchSavedRemoteHost(project.target, hosts);
    if (!host) continue;
    const group = byHost.get(host.connectionId) ?? [];
    group.push(project);
    byHost.set(host.connectionId, group);
  }
  return byHost;
}

export function HostProjectList({
  projects,
  onOpen,
}: {
  projects?: RemoteWorkspaceSessionEntry[];
  onOpen: (workspaceKey: string) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <h4 className="text-ui-sm font-medium">
        {intl.formatMessage({ id: "settings.nek.hostProjects.projects" })}
      </h4>
      {projects?.length ? (
        <ul className="flex flex-col gap-1">
          {projects.map((project) => {
            const key = buildWorkspaceSessionKey(project);
            return (
              <li key={key}>
                <AsyncButton
                  variant="ghost"
                  size="sm"
                  icon={<FolderIcon />}
                  successFeedback="none"
                  onClick={() => onOpen(key)}
                  className="h-auto min-h-8 w-full justify-start px-2 py-1 text-left [&>span:first-of-type]:min-w-0 [&>span:first-of-type]:flex-1"
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 whitespace-normal break-words font-mono text-ui-sm">
                      {project.workspacePath}
                    </span>
                    <ArrowUpRightIcon
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-foreground-subtle"
                    />
                  </span>
                </AsyncButton>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.nek.hostProjects.noProjects" })}
        </p>
      )}
    </div>
  );
}
