/**
 * MCP 服务器：全局 mcp.json 与当前项目的覆盖；状态来自目标机器上运行中的会话进程。
 * 添加（表单 / 粘贴 JSON 导入）、启停、暴露方式、逐工具暴露、超时、描述、测试、重连、OAuth、编辑、删除（撤销）。
 */
import { useMemo, useState } from "react";
import { CableIcon, ClipboardPasteIcon, PlusIcon } from "lucide-react";
import type { NekMcpServerEntry, NekMcpServerStatus } from "@zcode/shared/nek-protocol";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useUndoToast } from "@/components/ui/undo-toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import {
  useNekConfigApi,
  useNekSettingsContext,
  useNekTarget,
} from "../../api/NekSettingsContext.js";
import { useNekMcpDoc, type NekMcpDocument } from "../../api/mcpDocs.js";
import { useNekQuery } from "../../api/useNekQuery.js";
import { DiagnosticsList, DocumentGate, NekEmptyState } from "../../components/DocumentStatus.js";
import { NekPageFrame } from "../../components/NekPageFrame.js";
import { McpImportDialog } from "./McpImportDialog.js";
import { McpServerFormDialog } from "./McpServerFormDialog.js";
import { McpServerRow, type McpRowActions } from "./McpServerRow.js";

type FormState = { open: false } | { open: true; entry?: NekMcpServerEntry };

function useRowActions(
  doc: NekMcpDocument,
  statusReload: () => Promise<void>,
  cwd: string | undefined,
) {
  const { intl } = useZCodeIntl();
  const api = useNekConfigApi();
  const { target } = useNekTarget();
  const showUndo = useUndoToast();
  return (
    entry: NekMcpServerEntry,
    openEdit: (entry: NekMcpServerEntry) => void,
  ): McpRowActions => {
    const full = !entry.isOverride;
    const save = (patch: Partial<NekMcpServerEntry["config"]>) =>
      doc.saveServer({
        name: entry.name,
        config: { ...entry.config, ...patch } as NekMcpServerEntry["config"],
      });
    return {
      setEnabled: (enabled) => doc.setOverride(entry.name, { enabled }),
      setExposure: (exposure) => doc.setOverride(entry.name, { exposure }),
      setToolExposure: (tool, exposure) =>
        doc.setOverride(entry.name, {
          toolExposure: { ...entry.config.toolExposure, [tool]: exposure },
        }),
      setTimeout: full ? (timeout) => save({ timeout }) : undefined,
      setDescription: full
        ? (description) => save({ description: description || undefined })
        : undefined,
      edit: full ? () => openEdit(entry) : undefined,
      remove: () => {
        void doc
          .deleteServer(entry.name)
          .then(() =>
            showUndo({
              message: intl.formatMessage({ id: "settings.nek.mcp.deleted" }, { name: entry.name }),
              onUndo: () => {
                void doc
                  .saveServer({ name: entry.name, config: entry.config })
                  .catch((error: unknown) => toast(getErrorMessage(error), { variant: "warning" }));
              },
            }),
          )
          .catch((error: unknown) => toast(getErrorMessage(error), { variant: "warning" }));
      },
      test: async () => {
        const result = await api.testMcpServer(target, { name: entry.name, cwd });
        if (!result.ok) throw new Error(result.message);
        return intl.formatMessage(
          { id: "settings.nek.mcp.testOk" },
          { ms: result.latencyMs, count: result.tools.length },
        );
      },
      action: async (action) => {
        await api.mcpServerAction(target, entry.name, action, cwd);
        await statusReload();
      },
    };
  };
}

export function ServerList({
  doc,
  statuses,
  statusReload,
  cwd,
  onEdit,
}: {
  doc: NekMcpDocument;
  statuses: readonly NekMcpServerStatus[] | undefined;
  statusReload: () => Promise<void>;
  cwd: string | undefined;
  onEdit: (entry: NekMcpServerEntry) => void;
}) {
  const actionsFor = useRowActions(doc, statusReload, cwd);
  return (
    <div className="flex flex-col gap-2">
      {doc.data?.servers.map((entry) => (
        <McpServerRow
          key={entry.name}
          entry={entry}
          status={statuses?.find((status) => status.name === entry.name)}
          actions={actionsFor(entry, onEdit)}
        />
      ))}
    </div>
  );
}

export function McpPage() {
  const { intl } = useZCodeIntl();
  const { projectCwd } = useNekSettingsContext();
  const global = useNekMcpDoc("global");
  const project = useNekMcpDoc("project", projectCwd);
  const status = useNekQuery((api, target) => api.getMcpStatus(target, projectCwd), [projectCwd]);
  const [form, setForm] = useState<FormState>({ open: false });
  const [importOpen, setImportOpen] = useState(false);
  const names = useMemo(
    () => new Set(global.data?.servers.map((server) => server.name)),
    [global.data],
  );
  const statuses = status.data ?? undefined;

  return (
    <NekPageFrame
      usesTarget
      description={intl.formatMessage({ id: "settings.nek.mcp.pageDescription" })}
      documents={[global, project]}
      actions={
        <>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <ClipboardPasteIcon aria-hidden="true" />
            {intl.formatMessage({ id: "settings.nek.mcp.importJson" })}
          </Button>
          <Button onClick={() => setForm({ open: true })}>
            <PlusIcon aria-hidden="true" />
            {intl.formatMessage({ id: "settings.nek.mcp.add" })}
          </Button>
        </>
      }
    >
      <DocumentGate documents={[global]}>
        {() => (
          <div className="flex flex-col gap-6">
            <DiagnosticsList diagnostics={global.data?.diagnostics} />
            {status.status === "ready" && statuses === undefined ? (
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "settings.nek.mcp.noSession" })}
              </p>
            ) : null}
            {global.data?.servers.length === 0 ? (
              <NekEmptyState
                icon={<CableIcon className="size-5" aria-hidden="true" />}
                title={intl.formatMessage({ id: "settings.nek.mcp.emptyTitle" })}
                action={
                  <Button onClick={() => setForm({ open: true })}>
                    {intl.formatMessage({ id: "settings.nek.mcp.add" })}
                  </Button>
                }
              />
            ) : (
              <ServerList
                doc={global}
                statuses={statuses}
                statusReload={status.reload}
                cwd={projectCwd}
                onEdit={(entry) => setForm({ open: true, entry })}
              />
            )}
            {projectCwd && project.data && project.data.servers.length > 0 ? (
              <section className="flex flex-col gap-2">
                <h3 className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: "settings.nek.mcp.projectTitle" })}
                </h3>
                <p className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.nek.mcp.projectHint" }, { cwd: projectCwd })}
                </p>
                <ServerList
                  doc={project}
                  statuses={statuses}
                  statusReload={status.reload}
                  cwd={projectCwd}
                  onEdit={() => undefined}
                />
              </section>
            ) : null}
          </div>
        )}
      </DocumentGate>
      <McpServerFormDialog
        open={form.open}
        onOpenChange={(open) => !open && setForm({ open: false })}
        initial={
          form.open && form.entry ? { name: form.entry.name, config: form.entry.config } : undefined
        }
        existingNames={names}
        onSave={(name, config) =>
          global.saveServer({
            name,
            config,
            previousName: form.open && form.entry ? form.entry.name : undefined,
          })
        }
      />
      <McpImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        existingNames={names}
        onImport={async (items) => {
          for (const item of items) {
            await global.saveServer({
              name: item.name,
              config: item.config,
              previousName: item.overwrite ? item.name : undefined,
            });
          }
        }}
      />
    </NekPageFrame>
  );
}
