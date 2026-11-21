import { useEffect, useState } from "react";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import type {
  NekConfigScope,
  NekResourceCatalog,
  NekResourceInfo,
  NekResourceType,
} from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
import { SettingSection } from "@/components/ui/setting-fields.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSection } from "@/lib/settingsNavigation.js";
import { useNekSettingsContext } from "../../api/NekSettingsContext.js";
import { useNekQuery } from "../../api/useNekQuery.js";
import { DiagnosticsList, DocumentGate } from "../../components/DocumentStatus.js";
import { NekConfirmDialog } from "../../components/NekConfirmDialog.js";
import { NekPageFrame } from "../../components/NekPageFrame.js";
import { ResourceDialog } from "./ResourceDialog.js";
import {
  ResourceOpenButton,
  ResourceRow,
  resourceIsUnderRoot,
  type OpenRemoteResourcePath,
} from "./ResourceRow.js";

export function ResourcesPage({
  resourceType,
  openRemotePath,
}: {
  resourceType: NekResourceType;
  openRemotePath?: OpenRemoteResourcePath;
}) {
  const { intl } = useZCodeIntl();
  const { targetKey, projectCwd, targetInfo } = useNekSettingsContext();
  return (
    <NekPageFrame
      usesTarget
      description={intl.formatMessage({ id: `settings.nek.resources.page.${resourceType}` })}
    >
      <ResourceCatalog
        key={JSON.stringify([targetKey, projectCwd, targetInfo?.connected, resourceType])}
        resourceType={resourceType}
        openRemotePath={openRemotePath}
      />
    </NekPageFrame>
  );
}

function ResourceCatalog({
  resourceType,
  openRemotePath,
}: {
  resourceType: NekResourceType;
  openRemotePath?: OpenRemoteResourcePath;
}) {
  const { intl } = useZCodeIntl();
  const { config, target, projectCwd, subscribeChanges } = useNekSettingsContext();
  const query = { resourceType, cwd: projectCwd };
  const catalog = useNekQuery(
    (api, current) => api.listConfigResources(current, query),
    [resourceType, projectCwd],
  );
  const refresh = catalog.reload;
  useEffect(
    () =>
      subscribeChanges((change) => {
        if (/(?:^|[\\/])settings\.json$/u.test(change.file)) void refresh();
      }),
    [refresh, subscribeChanges],
  );

  const [creating, setCreating] = useState<NekConfigScope>();
  const [editing, setEditing] = useState<{
    entry: NekResourceInfo;
    content: string;
    revision: string;
  }>();
  const [deleting, setDeleting] = useState<NekResourceInfo>();
  const file = (entry: NekResourceInfo) => ({ ...query, path: entry.path });
  const onChanged = () => void refresh();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const data = catalog.data;
  return (
    <>
      <div className="flex justify-end">
        <AsyncButton
          variant="outline"
          size="sm"
          icon={<RefreshCwIcon />}
          onClick={refresh}
          disabled={catalog.status !== "ready"}
          disabledReason={t("settings.nek.load.loading")}
        >
          {t("settings.nek.resources.refresh")}
        </AsyncButton>
      </div>
      <DocumentGate documents={[catalog]}>
        {() =>
          data && (
            <div className="flex flex-col gap-6">
              {data.roots.project && !data.projectTrusted ? (
                <div
                  role="status"
                  className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3 text-ui-sm"
                >
                  <span>{t(`settings.nek.resources.untrusted.${resourceType}`)}</span>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setPendingSettingsSection("nekProject")}
                  >
                    {t("settings.nek.resources.manageTrust")}
                  </Button>
                </div>
              ) : null}
              <DiagnosticsList
                diagnostics={data.diagnostics.map(({ type, path, message }) => ({
                  severity: type === "error" ? "error" : "warning",
                  file: path ?? "",
                  message,
                }))}
              />
              {resourceGroups(data).map(({ scope, root, entries }) => (
                <SettingSection
                  key={scope}
                  title={t(`settings.nek.resources.group.${scope}`)}
                  description={root && <span className="break-all font-mono">{root}</span>}
                >
                  {root && (scope === "global" || data.projectTrusted) ? (
                    <div className="flex items-center gap-2">
                      <Button
                        variant={scope === "global" ? "default" : "outline"}
                        size="sm"
                        onClick={() => setCreating(scope as NekConfigScope)}
                      >
                        <PlusIcon aria-hidden="true" />
                        {t(`settings.nek.resources.create.${resourceType}`)}
                      </Button>
                      <ResourceOpenButton
                        path={root}
                        kind="directory"
                        openRemotePath={openRemotePath}
                      />
                    </div>
                  ) : null}
                  {entries.length === 0 ? (
                    <p className="py-2 text-ui-sm text-foreground-subtle">
                      {t("settings.nek.resources.empty")}
                    </p>
                  ) : null}
                  {entries.map((entry) => {
                    const writable =
                      scope !== "explicit" &&
                      (scope !== "project" || data.projectTrusted) &&
                      resourceIsUnderRoot(root, entry.path);
                    return (
                      <ResourceRow
                        key={entry.path}
                        entry={entry}
                        root={root}
                        file={file(entry)}
                        openRemotePath={openRemotePath}
                        onChanged={onChanged}
                        onDelete={writable ? () => setDeleting(entry) : undefined}
                        onEdit={
                          writable && resourceType === "prompts"
                            ? async () => {
                                const document = await config.readPromptTemplate(
                                  target,
                                  file(entry),
                                );
                                setEditing({ entry, ...document });
                              }
                            : undefined
                        }
                      />
                    );
                  })}
                </SettingSection>
              ))}
            </div>
          )
        }
      </DocumentGate>
      {creating && (
        <ResourceDialog
          editor={{ kind: "create", scope: creating }}
          query={query}
          onClose={() => setCreating(undefined)}
          onSaved={onChanged}
        />
      )}
      {editing && (
        <ResourceDialog
          editor={{
            kind: "edit",
            file: file(editing.entry),
            name: editing.entry.name,
            revision: editing.revision,
            content: editing.content,
          }}
          query={query}
          onClose={() => setEditing(undefined)}
          onSaved={onChanged}
        />
      )}
      {deleting && (
        <NekConfirmDialog
          open
          onOpenChange={() => setDeleting(undefined)}
          destructive
          title={t("settings.nek.resources.deleteTitle", { name: deleting.name })}
          description={t("settings.nek.resources.deleteHint", { path: deleting.path })}
          confirmLabel={t("settings.nek.resources.delete")}
          onConfirm={async () => {
            await config.deleteResource(target, file(deleting));
            onChanged();
          }}
        />
      )}
    </>
  );
}

function resourceGroups(data: NekResourceCatalog) {
  const global = {
    scope: "global" as const,
    root: data.roots.global,
    entries: [] as NekResourceInfo[],
  };
  const project = {
    scope: "project" as const,
    root: data.roots.project,
    entries: [] as NekResourceInfo[],
  };
  const explicit = {
    scope: "explicit" as const,
    root: undefined,
    entries: [] as NekResourceInfo[],
  };
  for (const resource of data.resources) {
    if (resource.scope === "project" && !data.projectTrusted) continue;
    if (resource.scope === "user" && resourceIsUnderRoot(global.root, resource.path))
      global.entries.push(resource);
    else if (resource.scope === "project" && resourceIsUnderRoot(project.root, resource.path))
      project.entries.push(resource);
    else explicit.entries.push(resource);
  }
  return [
    global,
    ...(project.root ? [project] : []),
    ...(explicit.entries.length ? [explicit] : []),
  ];
}
