/**
 * 粘贴 JSON 导入 MCP 服务器：兼容 Claude Desktop / Cursor 的 `mcpServers` 格式；
 * 先预览（勾选要导入的项），重名项逐个选择 覆盖 / 跳过 / 重命名。
 */
import { useEffect, useState } from "react";
import type { NekMcpImportPreview, NekMcpServerConfig } from "@zcode/shared/nek-protocol";
import { AsyncButton } from "@/components/ui/async-button.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useFocusRestore } from "@/hooks/useFocusRestore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "@/lib/technicalInputAttributes.js";
import { useNekConfigApi, useNekTarget } from "../../api/NekSettingsContext.js";
import { MCP_NAME_PATTERN, mcpTransportOf, suggestUniqueName } from "../../lib/mcpForm.js";
import { Segmented } from "../../components/inputs.js";

type Resolution = "overwrite" | "skip" | "rename";

interface ImportRow {
  name: string;
  config: NekMcpServerConfig;
  conflict: boolean;
  selected: boolean;
  resolution: Resolution;
  rename: string;
}

export interface McpImportItem {
  name: string;
  config: NekMcpServerConfig;
  overwrite: boolean;
}

/** 预览行 → 实际导入项；重命名不合法或仍重名时返回 null（主按钮禁用）。 */
export function resolveImport(
  rows: readonly ImportRow[],
  existing: ReadonlySet<string>,
): McpImportItem[] | null {
  const items: McpImportItem[] = [];
  const taken = new Set(existing);
  for (const row of rows) {
    if (!row.selected || (row.conflict && row.resolution === "skip")) continue;
    const name = row.conflict && row.resolution === "rename" ? row.rename.trim() : row.name;
    if (!MCP_NAME_PATTERN.test(name) || (row.resolution === "rename" && taken.has(name))) {
      return null;
    }
    taken.add(name);
    items.push({
      name,
      config: row.config,
      overwrite: row.conflict && row.resolution === "overwrite",
    });
  }
  return items;
}

export function McpImportDialog({
  open,
  onOpenChange,
  existingNames,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingNames: ReadonlySet<string>;
  onImport: (items: McpImportItem[]) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const api = useNekConfigApi();
  const { target } = useNekTarget();
  const focusRestore = useFocusRestore(open);
  const [json, setJson] = useState("");
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    if (open) {
      setJson("");
      setRows(null);
      setErrors([]);
    }
  }, [open]);

  const preview = async () => {
    const result: NekMcpImportPreview = await api.previewMcpImport(target, "global", json);
    setErrors(result.errors);
    setRows(
      result.servers.map((server) => ({
        ...server,
        selected: true,
        resolution: "skip",
        rename: suggestUniqueName(server.name, existingNames),
      })),
    );
  };
  const items = rows ? resolveImport(rows, existingNames) : null;
  const updateRow = (name: string, patch: Partial<ImportRow>) =>
    setRows(
      (current) => current?.map((row) => (row.name === name ? { ...row, ...patch } : row)) ?? null,
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl"
        onCloseAutoFocus={focusRestore.onCloseAutoFocus}
      >
        <DialogHeader className="pr-8">
          <DialogTitle>{t("settings.nek.mcp.import.title")}</DialogTitle>
          <DialogDescription>{t("settings.nek.mcp.import.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          <Textarea
            {...TECHNICAL_INPUT_ATTRIBUTES}
            autoFocus
            aria-label={t("settings.nek.mcp.import.jsonLabel")}
            value={json}
            placeholder={
              '{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"] }\n  }\n}'
            }
            className="min-h-32 font-mono"
            onChange={(event) => {
              setJson(event.target.value);
              setRows(null);
            }}
          />
          {errors.length > 0 ? (
            <ul role="alert" className="flex flex-col gap-0.5 text-ui-sm text-destructive">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
          {rows && rows.length > 0 ? (
            <ul
              aria-label={t("settings.nek.mcp.import.previewLabel")}
              className="flex flex-col gap-1 rounded-xl border border-card-border bg-card p-2"
            >
              {rows.map((row) => (
                <li key={row.name} className="flex flex-col gap-1.5 rounded-md px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={row.selected}
                      aria-label={row.name}
                      onCheckedChange={(checked) =>
                        updateRow(row.name, { selected: checked === true })
                      }
                    />
                    <span className="font-mono text-ui-sm text-foreground">{row.name}</span>
                    <span className="rounded-sm bg-tag px-1 text-ui-xs text-foreground-subtle">
                      {t(`settings.nek.mcp.transport.${mcpTransportOf(row.config)}`)}
                    </span>
                    {row.conflict ? (
                      <span className="text-ui-xs text-warning">
                        {t("settings.nek.mcp.import.conflict")}
                      </span>
                    ) : null}
                  </div>
                  {row.conflict && row.selected ? (
                    <div className="flex flex-wrap items-center gap-2 pl-6">
                      <Segmented<Resolution>
                        ariaLabel={t("settings.nek.mcp.import.resolution", { name: row.name })}
                        value={row.resolution}
                        options={[
                          { value: "skip", label: t("settings.nek.mcp.import.skip") },
                          { value: "overwrite", label: t("settings.nek.mcp.import.overwrite") },
                          { value: "rename", label: t("settings.nek.mcp.import.rename") },
                        ]}
                        onChange={(resolution) => updateRow(row.name, { resolution })}
                      />
                      {row.resolution === "rename" ? (
                        <Input
                          {...TECHNICAL_INPUT_ATTRIBUTES}
                          aria-label={t("settings.nek.mcp.import.newName")}
                          value={row.rename}
                          className="w-48 font-mono"
                          aria-invalid={
                            !MCP_NAME_PATTERN.test(row.rename.trim()) ||
                            existingNames.has(row.rename.trim()) ||
                            undefined
                          }
                          onChange={(event) => updateRow(row.name, { rename: event.target.value })}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          {rows === null ? (
            <AsyncButton
              disabled={json.trim() === ""}
              disabledReason={t("settings.nek.mcp.import.empty")}
              successFeedback="none"
              onClick={preview}
            >
              {t("settings.nek.mcp.import.preview")}
            </AsyncButton>
          ) : (
            <AsyncButton
              disabled={!items || items.length === 0}
              disabledReason={t("settings.nek.mcp.import.nothing")}
              successFeedback="none"
              onClick={async () => {
                if (items) {
                  await onImport(items);
                  onOpenChange(false);
                }
              }}
            >
              {t("settings.nek.mcp.import.confirm", { count: items?.length ?? 0 })}
            </AsyncButton>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
