/** nek v0.5.1: core/mcp-servers.ts (server validation) and extensions/mcp/config.ts (project overrides). */
import type {
  NekMcpExposure,
  NekMcpServerConfig,
  NekMcpServerOverride,
} from "./gui-extension-api.js";

export const NEK_MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const NEK_MCP_EXPOSURES = [
  "deferred",
  "direct",
  "hidden",
] as const satisfies readonly NekMcpExposure[];
export const NEK_MCP_OVERRIDE_KEYS = ["enabled", "exposure", "toolExposure"] as const;

/** Validate the raw key, without trimming or folding it. */
export function isNekMcpServerName(name: unknown): name is string {
  return typeof name === "string" && NEK_MCP_SERVER_NAME_PATTERN.test(name);
}

/** Normalize an exposure for display only; validation and saving keep the original string. */
export function normalizeNekMcpExposure(value: unknown): NekMcpExposure | undefined {
  switch (value) {
    case "codemode":
    case "codemode-deferred":
      return "deferred";
    case "deferred":
    case "direct":
    case "hidden":
      return value;
    default:
      return undefined;
  }
}

/** Infinity cannot be persisted as a JSON number. */
export function isNekMcpTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

type McpField =
  | "name"
  | "config"
  | "enabled"
  | "exposure"
  | "toolExposure"
  | "description"
  | "timeout"
  | "type"
  | "url"
  | "headers"
  | "auth"
  | "command"
  | "args"
  | "env"
  | "cwd"
  | "oauth"
  | "oauth.clientRegistration"
  | "oauth.clientId"
  | "oauth.clientSecret"
  | "oauth.callbackPort"
  | "oauth.callbackUrl"
  | "oauth.scope"
  | "oauth.clientName"
  | "oauth.authServerMetadataUrl";

interface McpConfigIssue {
  field: McpField;
  /** Localizable reason for the UI; message is the corresponding nek reason for services. */
  code: string;
  message: string;
  values?: Record<string, string>;
}

type Validation<T> = { ok: true; config: T } | { ok: false; issues: McpConfigIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function issue(
  field: McpField,
  code: string,
  message: string,
  values?: Record<string, string>,
): McpConfigIssue {
  return { field, code, message, values };
}

function stringIssue(field: McpField): McpConfigIssue {
  return issue(field, "stringType", `${field} must be a string`, { field });
}

function initialIssues(name: string): McpConfigIssue[] {
  return isNekMcpServerName(name)
    ? []
    : [
        issue(
          "name",
          "nameFormat",
          `invalid MCP server name ${JSON.stringify(name)} (use letters, digits, "_" and "-")`,
        ),
      ];
}

const EXPOSURES = NEK_MCP_EXPOSURES.map((value) => `"${value}"`).join(", ");
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function parseUrl(value: unknown): URL | undefined {
  return typeof value === "string" && URL.canParse(value) ? new URL(value) : undefined;
}

function checkOverrideFields(value: Record<string, unknown>, issues: McpConfigIssue[]): void {
  const { exposure, toolExposure, enabled } = value;
  if (exposure !== undefined && normalizeNekMcpExposure(exposure) === undefined) {
    issues.push(issue("exposure", "exposure", `exposure must be one of ${EXPOSURES}`));
  }
  if (toolExposure !== undefined) {
    if (!isRecord(toolExposure)) {
      issues.push(
        issue(
          "toolExposure",
          "toolExposureObject",
          "toolExposure must map tool names to exposures",
        ),
      );
    } else {
      for (const [tool, mode] of Object.entries(toolExposure)) {
        if (normalizeNekMcpExposure(mode) !== undefined) continue;
        issues.push(
          issue(
            "toolExposure",
            "toolExposureValue",
            `toolExposure "${tool}" must be one of ${EXPOSURES}`,
            { tool },
          ),
        );
        break;
      }
    }
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    issues.push(issue("enabled", "enabled", "enabled must be a boolean"));
  }
}

function checkOAuthCallback(value: Record<string, unknown>, issues: McpConfigIssue[]): void {
  const { callbackPort: port, callbackUrl } = value;
  const portInvalid =
    port !== undefined &&
    (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535);
  if (portInvalid)
    issues.push(
      issue("oauth.callbackPort", "port", "oauth.callbackPort must be a port number (1–65535)"),
    );
  if (callbackUrl === undefined) return;
  const url = parseUrl(callbackUrl);
  if (
    !url ||
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.includes(url.hostname) ||
    url.search ||
    url.hash
  ) {
    issues.push(
      issue(
        "oauth.callbackUrl",
        "callbackUrl",
        "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment",
      ),
    );
  } else if (!portInvalid && port !== undefined && url.port && Number(url.port) !== port) {
    issues.push(
      issue(
        "oauth.callbackUrl",
        "callbackPortMismatch",
        "oauth.callbackUrl and oauth.callbackPort name different ports",
      ),
    );
  }
}

function checkOAuth(value: unknown, issues: McpConfigIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push(issue("oauth", "oauthObject", "oauth must be an object"));
    return;
  }
  if (value.clientRegistration !== undefined) {
    issues.push(
      issue(
        "oauth.clientRegistration",
        "clientRegistration",
        "oauth.clientRegistration is not supported",
      ),
    );
  }
  for (const key of ["clientId", "clientSecret", "scope"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string")
      issues.push(stringIssue(`oauth.${key}`));
  }
  checkOAuthCallback(value, issues);
  if (
    value.clientName !== undefined &&
    (typeof value.clientName !== "string" || !value.clientName.trim())
  ) {
    issues.push(
      issue("oauth.clientName", "clientName", "oauth.clientName must be a non-empty string"),
    );
  }
  if (value.authServerMetadataUrl !== undefined) {
    const url = parseUrl(value.authServerMetadataUrl);
    if (
      !url ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))
      )
    ) {
      issues.push(
        issue(
          "oauth.authServerMetadataUrl",
          "metadataUrl",
          "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]",
        ),
      );
    }
  }
}

function checkHttp(value: Record<string, unknown>, issues: McpConfigIssue[]): void {
  const url = parseUrl(value.url);
  if (!url || !/^https?:$/.test(url.protocol))
    issues.push(issue("url", "url", "url must be an http or https URL"));
  if (value.headers !== undefined && !isStringRecord(value.headers)) {
    issues.push(
      issue("headers", "stringRecord", "headers must map names to strings", { field: "headers" }),
    );
  }
  if (value.auth !== undefined) {
    issues.push(
      issue("auth", "auth", "auth.provider is not supported; use OAuth or an Authorization header"),
    );
  }
  checkOAuth(value.oauth, issues);
}

function checkStdio(value: Record<string, unknown>, issues: McpConfigIssue[]): void {
  if (
    value.args !== undefined &&
    !(Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))
  ) {
    issues.push(issue("args", "args", "args must be an array of strings"));
  }
  if (value.env !== undefined && !isStringRecord(value.env)) {
    issues.push(issue("env", "stringRecord", "env must map names to strings", { field: "env" }));
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") issues.push(stringIssue("cwd"));
}

function checkTransport(value: Record<string, unknown>, issues: McpConfigIssue[]): void {
  const { type, url, command } = value;
  const http = type === "http" || type === "streamable-http";
  if (type === "sse") {
    issues.push(
      issue("type", "sse", "legacy SSE transport is not supported; use the streamable HTTP URL"),
    );
  } else if (typeof url === "string" && (type === undefined || http)) {
    checkHttp(value, issues);
  } else if (typeof command === "string" && (type === undefined || type === "stdio")) {
    checkStdio(value, issues);
  } else {
    const field =
      http || (type === undefined && url !== undefined)
        ? "url"
        : type === undefined || type === "stdio"
          ? "command"
          : "type";
    issues.push(
      issue(
        field,
        field === "url" ? "url" : field === "command" ? "commandRequired" : "transport",
        'needs either "command" (stdio) or "url" (streamable HTTP)',
      ),
    );
  }
}

/** Drafts cannot use `validate_config` (it only reads files). Match the core rules, collecting each field's reason. */
export function validateNekMcpServer(name: string, raw: unknown): Validation<NekMcpServerConfig> {
  const issues = initialIssues(name);
  if (!isRecord(raw)) {
    issues.push(issue("config", "serverObject", "server configuration must be an object"));
    return { ok: false, issues };
  }
  checkOverrideFields(raw, issues);
  if (raw.description !== undefined && typeof raw.description !== "string")
    issues.push(stringIssue("description"));
  if (raw.timeout !== undefined && !isNekMcpTimeout(raw.timeout)) {
    issues.push(issue("timeout", "timeout", "timeout must be a positive number of seconds"));
  }
  checkTransport(raw, issues);
  return issues.length ? { ok: false, issues } : { ok: true, config: raw as NekMcpServerConfig };
}

/** A project may write only override keys. The caller validates the merged config against its global base. */
export function validateNekMcpOverride(
  name: string,
  raw: unknown,
): Validation<NekMcpServerOverride> {
  const issues = initialIssues(name);
  if (!isRecord(raw)) {
    issues.push(issue("config", "serverObject", "server configuration must be an object"));
    return { ok: false, issues };
  }
  const extra = Object.keys(raw).filter(
    (key) => !(NEK_MCP_OVERRIDE_KEYS as readonly string[]).includes(key),
  );
  if (extra.length) {
    issues.push(
      issue(
        "config",
        "overrideKeys",
        `an override can only set ${NEK_MCP_OVERRIDE_KEYS.join(", ")}; unexpected keys: ${extra.join(", ")}`,
      ),
    );
  }
  checkOverrideFields(raw, issues);
  return issues.length ? { ok: false, issues } : { ok: true, config: raw };
}

/** The loader recognizes an override by the absence of all three definition fields. */
export function isNekMcpOverride(config: Record<string, unknown>): boolean {
  return config.command === undefined && config.url === undefined && config.type === undefined;
}
