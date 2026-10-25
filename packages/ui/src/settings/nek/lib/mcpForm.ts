/**
 * MCP 服务器表单：编辑态 ↔ mcp.json 配置，以及字段校验。
 */
import type { NekMcpExposure, NekMcpServerConfig } from "@zcode/shared/nek-protocol";
import { createKeyValueRow, recordFromRows, rowsFromRecord, type KeyValueRow } from "./keyValue.js";

export const MCP_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
export const MCP_EXPOSURES: readonly NekMcpExposure[] = ["deferred", "direct", "hidden"];
export const MCP_DEFAULT_TIMEOUT_SECONDS = 60;

export type McpTransport = "stdio" | "http";

export interface McpOauthDraft {
  clientId: string;
  clientSecret: string;
  callbackPort: string;
  scope: string;
}

export interface McpFormDraft {
  name: string;
  transport: McpTransport;
  description: string;
  command: string;
  /** 每行一个参数。 */
  args: string;
  env: KeyValueRow[];
  cwd: string;
  url: string;
  headers: KeyValueRow[];
  oauth: McpOauthDraft;
  timeout: string;
  exposure: NekMcpExposure;
  enabled: boolean;
  toolExposure?: Record<string, NekMcpExposure>;
}

export type McpFormField = "name" | "command" | "url" | "timeout" | "callbackPort";
export type McpFormErrors = Partial<Record<McpFormField, string>>;

export function mcpTransportOf(config: NekMcpServerConfig): McpTransport {
  return "url" in config ? "http" : "stdio";
}

export function emptyMcpDraft(): McpFormDraft {
  return {
    name: "",
    transport: "stdio",
    description: "",
    command: "",
    args: "",
    env: [],
    cwd: "",
    url: "",
    headers: [],
    oauth: { clientId: "", clientSecret: "", callbackPort: "", scope: "" },
    timeout: "",
    exposure: "deferred",
    enabled: true,
  };
}

export function mcpDraftFromConfig(name: string, config: NekMcpServerConfig): McpFormDraft {
  const base = emptyMcpDraft();
  const common = {
    ...base,
    name,
    description: config.description ?? "",
    timeout: config.timeout === undefined ? "" : String(config.timeout),
    exposure: config.exposure ?? "deferred",
    enabled: config.enabled !== false,
    toolExposure: config.toolExposure,
  };
  if ("url" in config) {
    return {
      ...common,
      transport: "http",
      url: config.url,
      headers: rowsFromRecord(config.headers),
      oauth: {
        clientId: config.oauth?.clientId ?? "",
        clientSecret: config.oauth?.clientSecret ?? "",
        callbackPort:
          config.oauth?.callbackPort === undefined ? "" : String(config.oauth.callbackPort),
        scope: config.oauth?.scope ?? "",
      },
    };
  }
  return {
    ...common,
    transport: "stdio",
    command: config.command,
    args: (config.args ?? []).join("\n"),
    env: rowsFromRecord(config.env),
    cwd: config.cwd ?? "",
  };
}

type Translate = (id: string, values?: Record<string, string | number>) => string;

function parsePositiveInt(text: string): number | null {
  const value = Number(text.trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function validateMcpDraft(
  draft: McpFormDraft,
  existingNames: ReadonlySet<string>,
  t: Translate,
): McpFormErrors {
  const errors: McpFormErrors = {};
  const name = draft.name.trim();
  if (name === "") {
    errors.name = t("settings.nek.mcp.form.error.nameRequired");
  } else if (!MCP_NAME_PATTERN.test(name)) {
    errors.name = t("settings.nek.mcp.form.error.nameFormat");
  } else if (existingNames.has(name)) {
    errors.name = t("settings.nek.mcp.form.error.nameDuplicate");
  }
  if (draft.transport === "stdio" && draft.command.trim() === "") {
    errors.command = t("settings.nek.mcp.form.error.commandRequired");
  }
  if (draft.transport === "http" && !/^https?:\/\/\S+$/i.test(draft.url.trim())) {
    errors.url = t("settings.nek.mcp.form.error.url");
  }
  if (draft.timeout.trim() !== "" && parsePositiveInt(draft.timeout) === null) {
    errors.timeout = t("settings.nek.mcp.form.error.timeout");
  }
  if (
    draft.oauth.callbackPort.trim() !== "" &&
    parsePositiveInt(draft.oauth.callbackPort) === null
  ) {
    errors.callbackPort = t("settings.nek.mcp.form.error.port");
  }
  return errors;
}

function optional(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
}

function oauthFromDraft(oauth: McpOauthDraft) {
  const result = {
    clientId: optional(oauth.clientId),
    clientSecret: optional(oauth.clientSecret),
    callbackPort: parsePositiveInt(oauth.callbackPort) ?? undefined,
    scope: optional(oauth.scope),
  };
  return Object.values(result).some((value) => value !== undefined) ? result : undefined;
}

/** 编辑态 → 配置（需先通过校验）；未填的可选字段不写入。 */
export function mcpConfigFromDraft(draft: McpFormDraft): NekMcpServerConfig {
  const common = {
    description: optional(draft.description),
    enabled: draft.enabled ? undefined : false,
    exposure: draft.exposure === "deferred" ? undefined : draft.exposure,
    toolExposure: draft.toolExposure,
    timeout: parsePositiveInt(draft.timeout) ?? undefined,
  };
  if (draft.transport === "http") {
    return stripUndefined({
      ...common,
      type: "http" as const,
      url: draft.url.trim(),
      headers: recordFromRows(draft.headers),
      oauth: oauthFromDraft(draft.oauth),
    });
  }
  const args = draft.args
    .split("\n")
    .map((arg) => arg.trim())
    .filter((arg) => arg !== "");
  return stripUndefined({
    ...common,
    command: draft.command.trim(),
    args: args.length > 0 ? args : undefined,
    env: recordFromRows(draft.env),
    cwd: optional(draft.cwd),
  });
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

/** 导入重名时建议的新名称：`name-2`、`name-3`…… */
export function suggestUniqueName(name: string, taken: ReadonlySet<string>): string {
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${name}-${index}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return `${name}-${Date.now()}`;
}

export function addKeyValueRow(rows: readonly KeyValueRow[]): KeyValueRow[] {
  return [...rows, createKeyValueRow()];
}
