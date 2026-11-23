import { ExternalLinkIcon } from "lucide-react";
import { AsyncButton } from "@/components/ui/async-button.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNekSettingsContext } from "../../api/NekSettingsContext.js";

/** Open a path only on its owning target, never by interpreting a remote path locally. */
export function AgentFileOpenButton({ path }: { path: string }) {
  const { intl } = useZCodeIntl();
  const { host, target, projectCwd } = useNekSettingsContext();
  const platform = useOptionalPlatform();
  const { remoteTarget } = useWorkspaceOpenInEditorTarget({
    workspacePath: target.kind === "remote" ? projectCwd : undefined,
    workspaceRemoteSessionId: target.kind === "remote" ? target.connectionId : undefined,
  });
  const external = platform && (remoteTarget?.kind === "ssh" || remoteTarget?.kind === "wsl");
  const open = async () => {
    if (target.kind === "local") return host.openPath(target, path);
    if (!external) throw new Error(intl.formatMessage({ id: "settings.nek.resources.openFailed" }));
    const result = await platform.openInEditor("vscode", path, { remoteTarget, pathKind: "file" });
    if (!result.success)
      throw new Error(
        result.error ?? intl.formatMessage({ id: "settings.nek.resources.openFailed" }),
      );
  };
  return (
    <AsyncButton
      variant="ghost"
      size="sm"
      icon={<ExternalLinkIcon />}
      disabled={target.kind === "remote" && !external}
      disabledReason={intl.formatMessage(
        { id: "settings.nek.agent.openRemoteFileUnavailable" },
        { path },
      )}
      successFeedback="none"
      onClick={open}
    >
      {intl.formatMessage({ id: "settings.nek.resources.open.file" })}
    </AsyncButton>
  );
}
