/** Edit projection for mcp.json: use nek's validator, and patch only changed draft fields. */
import {
  normalizeNekMcpExposure,
  validateNekMcpServer,
  type NekMcpExposure,
  type NekMcpServerConfig,
  type NekMcpServerOverride,
} from "@zcode/shared/nek-protocol";
import { rowsFromRecord, type KeyValueRow } from "./keyValue.js";

export { NEK_MCP_EXPOSURES as MCP_EXPOSURES } from "@zcode/shared/nek-protocol";
export const MCP_DEFAULT_TIMEOUT_SECONDS = 60;

export type McpTransport = "stdio" | "http";

export const MCP_OAUTH_FIELDS = [
  "clientId",
  "clientSecret",
  "callbackPort",
  "callbackUrl",
  "scope",
  "clientName",
  "authServerMetadataUrl",
] as const;
export type McpOauthDraft = Record<(typeof MCP_OAUTH_FIELDS)[number], string>;

export interface McpFormDraft {
  name: string;
  transport: McpTransport | "";
  description: string;
  command?: string;
  /** Each line represents one argument. */
  args: string;
  env: KeyValueRow[];
  cwd: string;
  url: string;
  headers: KeyValueRow[];
  oauth: McpOauthDraft;
  timeout: string;
  exposure: NekMcpExposure | "";
}

type McpFormField = Extract<
  ReturnType<typeof validateNekMcpServer>,
  { ok: false }
>["issues"][number]["field"];
export type McpFormErrors = Partial<Record<McpFormField, string>>;

type Translate = (id: string, values?: Record<string, string | number>) => string;

interface McpFormBaseline {
  config: NekMcpServerConfig;
  draft: McpFormDraft;
}

export function mcpTransportOf(config: NekMcpServerConfig | NekMcpServerOverride): McpTransport {
  return "url" in config || ("type" in config && config.type !== "stdio") ? "http" : "stdio";
}

function oauthDraft(value: Record<string, unknown>): McpOauthDraft {
  return Object.fromEntries(
    MCP_OAUTH_FIELDS.map((key) => [key, draftText(value[key])]),
  ) as McpOauthDraft;
}

export function emptyMcpDraft(): McpFormDraft {
  return {
    name: "",
    transport: "stdio",
    description: "",
    args: "",
    env: [],
    cwd: "",
    url: "",
    headers: [],
    oauth: oauthDraft({}),
    timeout: "",
    exposure: "deferred",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function draftText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

function draftRows(input: unknown): KeyValueRow[] {
  return rowsFromRecord(
    Object.fromEntries(
      Object.entries(asRecord(input)).map(([key, value]) => [key, draftText(value)]),
    ),
  );
}

export function mcpDraftFromConfig(name: string, config: NekMcpServerConfig): McpFormDraft {
  const raw = asRecord(config);
  const { type } = raw;
  const transport =
    type === "stdio"
      ? "stdio"
      : type === "http" || type === "streamable-http"
        ? "http"
        : type !== undefined
          ? ""
          : typeof raw.url === "string"
            ? "http"
            : "stdio";
  return {
    name,
    transport,
    description: draftText(raw.description),
    command: raw.command === undefined ? undefined : draftText(raw.command),
    args: Array.isArray(raw.args) ? raw.args.map(draftText).join("\n") : "",
    env: draftRows(raw.env),
    cwd: draftText(raw.cwd),
    url: draftText(raw.url),
    headers: draftRows(raw.headers),
    oauth: oauthDraft(asRecord(raw.oauth)),
    timeout: draftText(raw.timeout),
    exposure:
      raw.exposure === undefined ? "deferred" : (normalizeNekMcpExposure(raw.exposure) ?? ""),
  };
}

function parseOptionalNumber(text: string): number | undefined {
  return text.trim() === "" ? undefined : Number(text);
}

function optionalText(text: string): string | undefined {
  return text === "" ? undefined : text;
}

function setField(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function rowsKey(rows: readonly KeyValueRow[]) {
  return JSON.stringify(rows.map((row) => [row.key, row.value]));
}

function writeRows(rows: readonly KeyValueRow[], before: readonly KeyValueRow[]) {
  const originalEmptyKey = before.find((row) => row.key === "")?.id;
  const entries = rows.filter((row) => row.key || row.value || row.id === originalEmptyKey);
  return entries.length
    ? Object.fromEntries(entries.map((row) => [row.key, row.value]))
    : undefined;
}

function editOAuth(original: unknown, draft: McpOauthDraft, before: McpOauthDraft) {
  const changed = MCP_OAUTH_FIELDS.filter((key) => draft[key] !== before[key]);
  if (!changed.length) return original;
  const result = { ...asRecord(original) };
  for (const key of changed)
    setField(
      result,
      key,
      key === "callbackPort" ? parseOptionalNumber(draft[key]) : optionalText(draft[key]),
    );
  return Object.keys(result).length > 0 ? result : undefined;
}

/** A changed transport replaces its old fields; all other changes are field-local. */
function candidateFromDraft(draft: McpFormDraft, baseline?: McpFormBaseline) {
  const source = baseline?.config;
  const before = baseline?.draft ?? emptyMcpDraft();
  const config = { ...asRecord(source) };
  if (draft.description !== before.description)
    setField(config, "description", optionalText(draft.description));
  if (draft.timeout !== before.timeout)
    setField(config, "timeout", parseOptionalNumber(draft.timeout));
  if (draft.exposure !== before.exposure)
    setField(config, "exposure", draft.exposure === "deferred" ? undefined : draft.exposure);
  if (!draft.transport) return config;

  const switched = Boolean(baseline) && draft.transport !== before.transport;
  if (switched || !baseline)
    setField(config, "type", draft.transport === "http" ? "http" : undefined);
  if (draft.transport === "http") {
    if (switched) for (const key of ["command", "args", "env", "cwd"]) delete config[key];
    if (draft.url !== before.url || typeof config.url !== "string") config.url = draft.url;
    if (rowsKey(draft.headers) !== rowsKey(before.headers))
      setField(config, "headers", writeRows(draft.headers, before.headers));
    setField(config, "oauth", editOAuth(config.oauth, draft.oauth, before.oauth));
  } else {
    if (switched) for (const key of ["url", "headers", "oauth", "auth"]) delete config[key];
    if (draft.command !== before.command) setField(config, "command", draft.command);
    if (draft.args !== before.args)
      setField(config, "args", draft.args === "" ? undefined : draft.args.split("\n"));
    if (rowsKey(draft.env) !== rowsKey(before.env))
      setField(config, "env", writeRows(draft.env, before.env));
    if (draft.cwd !== before.cwd) setField(config, "cwd", optionalText(draft.cwd));
  }
  return config;
}

/** Validate the exact candidate that the form will send, not a differently normalized draft. */
export function resolveMcpDraft(
  draft: McpFormDraft,
  existingNames: ReadonlySet<string>,
  t: Translate,
  baseline?: McpFormBaseline,
) {
  const checked = validateNekMcpServer(draft.name, candidateFromDraft(draft, baseline));
  const errors: McpFormErrors = {};
  if (!checked.ok) {
    for (const { field, code, values } of checked.issues) {
      errors[field] = t(`settings.nek.mcp.form.error.${code}`, values);
    }
  }
  if (draft.name === "") errors.name = t("settings.nek.mcp.form.error.nameRequired");
  else if (!errors.name && existingNames.has(draft.name))
    errors.name = t("settings.nek.mcp.form.error.nameDuplicate");
  const config = checked.ok && !errors.name ? checked.config : undefined;
  return { errors, config };
}

/** 导入重名时建议的新名称：`name-2`、`name-3`…… */
export function suggestUniqueName(name: string, taken: ReadonlySet<string>): string {
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${name}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${name}-${Date.now()}`;
}
