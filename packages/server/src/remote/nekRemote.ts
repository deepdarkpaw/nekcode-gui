import type { NekGuiInfo } from "@zcode/shared/nek-protocol";
import {
  NEK_GUI_PROTOCOL_VERSION,
  NEK_GUI_MIN_VERSION,
  isNekGuiVersionSupported,
} from "@zcode/shared/nek-protocol";
import type { IRemoteBackend, StdioStream } from "./backend.js";
import { buildLoginShellCommand, quotePosixShellArg } from "./posixShell.js";

const MAX_STDOUT_BYTES = 128 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
/** 登录 shell 初始化 + `gui-info` 的等待上限；交互式 rc 卡住时明确失败而不是一直转圈。 */
const DEFAULT_DETECT_TIMEOUT_MS = 30_000;
/** 失败原因里带上的 stderr 末尾行数。 */
const ERROR_DETAIL_LINES = 3;
const DEFAULT_INSTALL_REPO_URL = "https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek";

/**
 * 远端检测命令：经用户登录 shell 运行，PATH 与远端 gui-server 一致。
 * nek 启动器按 PATH 选 Node；nvm 等只在交互段生效时，非交互 `sh -lc` 会挑到系统旧 Node
 * （例如 Ubuntu 22.04 的 v12，`node: bad option: --import`，退出码 9）。
 */
export const REMOTE_GUI_INFO_COMMAND = buildLoginShellCommand("nek gui-info --json");

/** 交互式 shell 在没有终端的 exec 通道里固定打印的提示，不是失败原因。 */
const INTERACTIVE_SHELL_NOISE =
  /^(?:\S*sh: )?(?:cannot set terminal process group|no job control in this shell)/iu;

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
  /** 等待上限，默认 30 s。 */
  timeoutMs?: number;
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

/** 等可读端读完：ssh2 可能先报退出码、后派发最后一段 stdout。 */
function waitForEnd(stream: NodeJS.ReadableStream): Promise<void> {
  const state = stream as NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean };
  if (state.readableEnded || state.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      stream.off("end", done);
      stream.off("close", done);
      stream.off("error", done);
      resolve();
    };
    stream.on("end", done);
    stream.on("close", done);
    stream.on("error", done);
  });
}

/** 退出码与完整输出；超时返回 `null`。 */
async function waitForExit(stream: StdioStream, timeoutMs: number): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const exited = Promise.all([
    waitForClose(stream),
    waitForEnd(stream.stdout),
    waitForEnd(stream.stderr),
  ]).then(([code]) => code);
  try {
    return await Promise.race([exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 检测用的 stderr 摘要：去掉交互式 shell 的无终端提示。 */
function summarizeDetectStderr(stderr: string): string {
  const meaningful = stderr
    .split(/\r?\n/u)
    .filter((line) => !INTERACTIVE_SHELL_NOISE.test(line.trim()))
    .join("\n");
  return summarizeRemoteStderr(meaningful);
}

function withDetail(message: string, stderrSummary: string): string {
  const detail = stderrSummary.split("\n").slice(-ERROR_DETAIL_LINES).join("\n");
  return detail ? `${message}: ${detail}` : message;
}

/** 登录 shell 找不到 `nek`：127 是 POSIX shell 与 fish 共同的"命令不存在"退出码。 */
function isNotInstalled(code: number, stderr: string): boolean {
  if (code === 0) return false;
  return (
    code === 127 ||
    /(?:\bnek: (?:command )?not found|command not found: nek\b|unknown command:? '?nek\b)/iu.test(
      stderr,
    )
  );
}

/** 在远端登录 shell 中检测 nek，不通过本机 PATH 猜测远端安装位置。 */
export async function detectRemoteNek(
  backend: IRemoteBackend,
  options: RemoteNekCheckOptions = {},
): Promise<RemoteNekCheckResult> {
  let stream: StdioStream;
  try {
    stream = await backend.exec(REMOTE_GUI_INFO_COMMAND);
  } catch (error) {
    return {
      status: "failed",
      stderrSummary: summarizeRemoteStderr(error instanceof Error ? error.message : String(error)),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  // 交互式 rc 若读 stdin，立即拿到 EOF 而不是挂住检测。
  stream.stdin.end();
  const stdout = collectStream(stream.stdout, options.maxOutputBytes ?? MAX_STDOUT_BYTES);
  const stderr = collectStream(stream.stderr, MAX_STDERR_BYTES);
  const timeoutMs = options.timeoutMs ?? DEFAULT_DETECT_TIMEOUT_MS;
  const code = await waitForExit(stream, timeoutMs);
  const stderrSummary = summarizeDetectStderr(stderr.read());
  stdout.dispose();
  stderr.dispose();
  if (code === null) {
    stream.signal?.("KILL");
    destroyStream(stream);
    return {
      status: "failed",
      stderrSummary,
      error: withDetail(
        `nek gui-info did not finish within ${Math.round(timeoutMs / 1000)} s (the remote login shell may be waiting for input)`,
        stderrSummary,
      ),
    };
  }
  if (isNotInstalled(code, stderr.read())) return { status: "not_installed", stderrSummary };
  if (code !== 0) {
    return {
      status: "failed",
      stderrSummary,
      error: withDetail(`nek gui-info exited with ${code}`, stderrSummary),
    };
  }
  const info = parseGuiInfo(stdout.read());
  if (!info) {
    return {
      status: "failed",
      stderrSummary,
      error: withDetail("nek gui-info returned invalid JSON", stderrSummary),
    };
  }
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
  if (!isNekGuiVersionSupported(info.nekVersion)) {
    return {
      status: "incompatible",
      info,
      protocolVersion: info.protocolVersion,
      stderrSummary,
      error: `nek ${info.nekVersion} is not compatible with GUI history paging and live streams; update nek to ${NEK_GUI_MIN_VERSION} or newer`,
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
