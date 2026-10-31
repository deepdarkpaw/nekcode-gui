import type { NekGuiInfo } from "@zcode/shared/nek-protocol";
import { NEK_GUI_PROTOCOL_VERSION } from "@zcode/shared/nek-protocol";
import type { IRemoteBackend, StdioStream } from "./backend.js";
import { quotePosixShellArg } from "./posixShell.js";

const MAX_STDOUT_BYTES = 128 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const DEFAULT_INSTALL_REPO_URL = "https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek";

export type RemoteNekStatus = "ready" | "not_installed" | "incompatible" | "failed";

export interface RemoteNekCheckResult {
  status: RemoteNekStatus;
  info?: NekGuiInfo;
  protocolVersion?: number;
  stderrSummary: string;
  error?: string;
}

export interface RemoteNekCheckOptions {
  requiredProtocolVersion?: number;
  maxOutputBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseGuiInfo(stdout: string): NekGuiInfo | null {
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const value: unknown = JSON.parse(line.trim());
      if (!isRecord(value) || typeof value.protocolVersion !== "number") continue;
      return value as unknown as NekGuiInfo;
    } catch {
      // nek may print a diagnostic before its JSON response; keep looking.
    }
  }
  return null;
}

export function summarizeRemoteStderr(stderr: string, maxChars = MAX_STDERR_BYTES): string {
  const lines = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = lines.slice(-20).join("\n");
  return summary.length > maxChars ? `${summary.slice(0, maxChars)}…` : summary;
}

function collectStream(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
): {
  read(): string;
  dispose(): void;
} {
  let value = "";
  const onData = (chunk: Buffer | string) => {
    value = `${value}${chunk.toString()}`.slice(-maxBytes);
  };
  stream.on("data", onData);
  return { read: () => value, dispose: () => stream.off("data", onData) };
}

function waitForClose(stream: StdioStream): Promise<number> {
  return new Promise((resolve) => stream.onClose(resolve));
}

function isNotInstalled(code: number, stderr: string): boolean {
  return (
    code === 127 || /(?:nek: command not found|not found|no such file or directory)/iu.test(stderr)
  );
}

/** 在远端 shell 中检测 nek，不通过本机 PATH 猜测远端安装位置。 */
export async function detectRemoteNek(
  backend: IRemoteBackend,
  options: RemoteNekCheckOptions = {},
): Promise<RemoteNekCheckResult> {
  let stream: StdioStream;
  try {
    stream = await backend.exec("sh -lc 'nek gui-info --json'");
  } catch (error) {
    return {
      status: "failed",
      stderrSummary: summarizeRemoteStderr(error instanceof Error ? error.message : String(error)),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const stdout = collectStream(stream.stdout, options.maxOutputBytes ?? MAX_STDOUT_BYTES);
  const stderr = collectStream(stream.stderr, MAX_STDERR_BYTES);
  const code = await waitForClose(stream);
  const stderrSummary = summarizeRemoteStderr(stderr.read());
  stdout.dispose();
  stderr.dispose();
  if (isNotInstalled(code, stderr.read())) return { status: "not_installed", stderrSummary };
  if (code !== 0) {
    return { status: "failed", stderrSummary, error: `nek gui-info exited with ${code}` };
  }
  const info = parseGuiInfo(stdout.read());
  if (!info)
    return { status: "failed", stderrSummary, error: "nek gui-info returned invalid JSON" };
  const required = options.requiredProtocolVersion ?? NEK_GUI_PROTOCOL_VERSION;
  if (info.protocolVersion !== required) {
    return {
      status: "incompatible",
      info,
      protocolVersion: info.protocolVersion,
      stderrSummary,
      error: `protocol ${info.protocolVersion} is incompatible with required ${required}`,
    };
  }
  return { status: "ready", info, protocolVersion: info.protocolVersion, stderrSummary };
}

export interface InstallNekOptions {
  channel?: "stable" | "dev";
  repoUrl?: string;
  nodeMirror?: string;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
}

export interface InstallNekResult {
  ok: boolean;
  cancelled: boolean;
  exitCode: number | null;
  manualCommand?: string;
  stderrSummary: string;
}

function installEnvironment(options: InstallNekOptions): Record<string, string> {
  return {
    NEK_CHANNEL: options.channel ?? "stable",
    NEK_REPO_URL: options.repoUrl ?? "https://github.com/deepdarkpaw/nekcode.git",
    NEK_NODE_MIRROR: options.nodeMirror ?? "https://nodejs.org/dist",
  };
}

export function buildNekInstallCommand(options: InstallNekOptions = {}): string {
  const environment = installEnvironment(options);
  const repoUrl = options.repoUrl ?? DEFAULT_INSTALL_REPO_URL;
  const assignments = Object.entries(environment)
    .map(([key, value]) => `${key}=${quotePosixShellArg(value)}`)
    .join(" ");
  const installUrl = `${repoUrl.replace(/\/$/u, "")}/scripts/install.sh`;
  return `curl -fsSL ${quotePosixShellArg(installUrl)} | ${assignments} bash`;
}

function quotePowerShellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Windows 本机安装命令：nek 官方的 Windows 安装方式是 PowerShell 的 `install.ps1`
 * （`install.sh` 需要 bash，普通 Windows 用户没有）。环境变量与 `install.sh` 同名同义。
 */
export function buildNekInstallPowerShellCommand(options: InstallNekOptions = {}): string {
  const environment = installEnvironment(options);
  const repoUrl = options.repoUrl ?? DEFAULT_INSTALL_REPO_URL;
  const assignments = Object.entries(environment)
    .map(([key, value]) => `$env:${key}=${quotePowerShellString(value)}`)
    .join("; ");
  const installUrl = `${repoUrl.replace(/\/$/u, "")}/scripts/install.ps1`;
  return `${assignments}; irm ${quotePowerShellString(installUrl)} | iex`;
}

function destroyStream(stream: StdioStream): void {
  for (const candidate of [stream.stdin, stream.stdout, stream.stderr]) {
    (candidate as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  }
}

/** 流式执行官方 install.sh；取消会先发 INT，再关闭当前 SSH channel。 */
export async function installRemoteNek(
  backend: IRemoteBackend,
  options: InstallNekOptions = {},
): Promise<InstallNekResult> {
  const command = buildNekInstallCommand(options);
  const stream = await backend.exec(`sh -lc ${quotePosixShellArg(command)}`);
  let output = "";
  let lineBuffer = "";
  const emit = (chunk: Buffer | string) => {
    output = `${output}${chunk.toString()}`.slice(-MAX_STDERR_BYTES);
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split(/\r?\n/u);
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) options.onLog?.(line);
  };
  stream.stdout.on("data", emit);
  stream.stderr.on("data", emit);
  let cancelled = options.signal?.aborted ?? false;
  let abortHandler: (() => void) | undefined;
  if (options.signal) {
    abortHandler = () => {
      cancelled = true;
      stream.signal?.("INT");
      stream.stdin.end();
      destroyStream(stream);
    };
    options.signal.addEventListener("abort", abortHandler, { once: true });
    if (cancelled) abortHandler();
  }
  const exitCode = await waitForClose(stream);
  if (lineBuffer.trim()) options.onLog?.(lineBuffer);
  if (abortHandler) options.signal?.removeEventListener("abort", abortHandler);
  const ok = !cancelled && exitCode === 0;
  return {
    ok,
    cancelled,
    exitCode,
    stderrSummary: summarizeRemoteStderr(output),
    ...(ok ? {} : { manualCommand: command }),
  };
}
