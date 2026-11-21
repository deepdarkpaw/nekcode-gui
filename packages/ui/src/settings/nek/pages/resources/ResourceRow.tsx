import { useId } from "react";
import { ExternalLinkIcon, FolderOpenIcon, PencilIcon, Trash2Icon } from "lucide-react";
import type { NekResourceFileRef, NekResourceInfo } from "@zcode/shared/nek-protocol";
import { ActionTooltip } from "@/components/ui/action-tooltip.js";
import { AsyncButton } from "@/components/ui/async-button.js";
import { IconButton } from "@/components/ui/icon-button.js";
import { SettingRow } from "@/components/ui/setting-fields.js";
import { Switch } from "@/components/ui/switch.js";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { filePathComparisonKey, getContainingDirectoryPath } from "@/lib/path.js";
import { useNekConfigApi, useNekHostApi, useNekTarget } from "../../api/NekSettingsContext.js";

export type OpenRemoteResourcePath = (path: string, kind: "file" | "directory") => Promise<void>;

export function resourceIsUnderRoot(root: string | undefined, path: string): boolean {
  if (!root) return false;
  const prefix = `${filePathComparisonKey(root)}/`;
  const normalized = filePathComparisonKey(path);
  return (
    normalized.startsWith(prefix) && !normalized.slice(prefix.length).split("/").includes("..")
  );
}

/** 保留实际目标路径用于复制；列表中使用相对配置根的更短显示。 */
function displayPath(root: string | undefined, path: string): string {
  return root && resourceIsUnderRoot(root, path) ? path.slice(root.length + 1) : path;
}

export function ResourceOpenButton({
  path,
  kind,
  openRemotePath,
}: {
  path: string;
  kind: "file" | "directory";
  openRemotePath?: OpenRemoteResourcePath;
}) {
  const { intl } = useZCodeIntl();
  const { target } = useNekTarget();
  const host = useNekHostApi();
  const icon = kind === "file" ? <ExternalLinkIcon /> : <FolderOpenIcon />;
  const label = intl.formatMessage({ id: `settings.nek.resources.open.${kind}` });
  const disabled = target.kind === "remote" && !openRemotePath;
  return (
    <AsyncButton
      variant="ghost"
      size="icon-sm"
      label={label}
      icon={icon}
      disabled={disabled}
      disabledReason={intl.formatMessage({ id: "settings.nek.openDir.remote" }, { path })}
      onClick={() => {
        if (target.kind === "local") return host.openPath(target, path);
        if (!openRemotePath)
          throw new Error(intl.formatMessage({ id: "settings.nek.resources.openFailed" }));
        return openRemotePath(path, kind);
      }}
    />
  );
}

export function ResourceRow({
  entry,
  root,
  file,
  openRemotePath,
  onChanged,
  onDelete,
  onEdit,
}: {
  entry: NekResourceInfo;
  root?: string;
  file: NekResourceFileRef;
  openRemotePath?: OpenRemoteResourcePath;
  onChanged: () => void;
  onDelete?: () => void;
  onEdit?: () => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const api = useNekConfigApi();
  const { target } = useNekTarget();
  const id = useId();
  const action = useAsyncAction(async (enabled: boolean) => {
    const result = await api.setResourceEnabled(target, { ...file, enabled });
    onChanged();
    if (result.enabled !== enabled)
      throw new Error(intl.formatMessage({ id: "settings.nek.resources.override" }));
  });
  const dirname = getContainingDirectoryPath(entry.path);
  const toggleLabel = intl.formatMessage(
    { id: "settings.nek.resources.enabled" },
    { name: entry.name },
  );
  const disabledReason = intl.formatMessage({ id: "settings.nek.resources.notToggleable" });
  const editLabel = intl.formatMessage({ id: "settings.nek.resources.edit" });
  const busy = action.state.status === "pending";
  return (
    <SettingRow
      htmlFor={id}
      label={
        <span className="break-all font-mono">
          {entry.resourceType === "prompts" ? "/" : ""}
          {entry.name}
        </span>
      }
      description={
        <>
          {entry.description ? (
            <span className="block break-words">{entry.description}</span>
          ) : null}
          <span className="block break-all font-mono" title={entry.path}>
            {displayPath(root, entry.path)}
          </span>
          {entry.scope === "temporary" ? (
            <span className="block break-all">{entry.source}</span>
          ) : null}
        </>
      }
      state={action.state}
      trailing={
        <>
          <ResourceOpenButton path={entry.path} kind="file" openRemotePath={openRemotePath} />
          {dirname && (
            <ResourceOpenButton path={dirname} kind="directory" openRemotePath={openRemotePath} />
          )}
          {onEdit && (
            <AsyncButton
              variant="ghost"
              size="icon-sm"
              icon={<PencilIcon />}
              label={editLabel}
              onClick={onEdit}
            />
          )}
          {onDelete && (
            <IconButton
              variant="ghost"
              size="icon-sm"
              label={intl.formatMessage({ id: "settings.nek.resources.delete" })}
              onClick={onDelete}
            >
              <Trash2Icon />
            </IconButton>
          )}
        </>
      }
    >
      <ActionTooltip
        label={toggleLabel}
        disabled={!entry.toggleable}
        disabledReason={disabledReason}
      >
        <Switch
          id={id}
          aria-label={toggleLabel}
          checked={entry.enabled}
          disabled={!entry.toggleable || busy}
          aria-busy={busy || undefined}
          onCheckedChange={(value) => void action.run(value)}
        />
      </ActionTooltip>
    </SettingRow>
  );
}
