import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import {
  NEK_GUI_PROTOCOL_VERSION,
  NEK_GUI_MIN_VERSION,
  isNekGuiVersionSupported,
} from "@zcode/shared/nek-protocol";
import type { NekGuiInfo } from "@zcode/shared/nek-protocol";

/**
 * 定位本机的 nek 启动器并读取 `nek gui-info --json`。
 *
 * 查找顺序（先找到先用）：
 * 1. 设置里显式配置的启动器路径；
 * 2. `PATH` 里的 `nek`（Windows 上还有 `nek.cmd` / `nek.exe` / `nek.bat`）；
 * 3. Windows `%LOCALAPPDATA%\nekcode\bin\nek.cmd`，其他平台 `~/.local/bin/nek`。
 *
 * 读到的 `NekGuiInfo` 按"启动器路径 + mtime + size"缓存：升级 nek 会改 mtime，缓存自动失效
 * （有界 LRU，最多记 8 个启动器）。
 */

export type NekLocatorErrorCode = "not_found" | "incompatible" | "failed";

export class NekLocatorError extends Error {
  constructor(
    readonly code: NekLocatorErrorCode,
    message: string,
    readonly detail?: {
      launcherPath?: string;
      /** 已安装版本与 GUI 要求的版本（`incompatible` 时都有值）。 */
      actualProtocolVersion?: number;
      expectedProtocolVersion?: number;
      actualNekVersion?: string;
      requiredNekVersion?: string;
      stderrSummary?: string;
    },
  ) {
    super(message);
    this.name = "NekLocatorError";
  }
}

export interface NekLocatorCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface NekLocatorDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: string;
  /** 文件信息；不存在返回 null。 */
  statFile: (path: string) => Promise<{ mtimeMs: number; size: number } | null>;
  /** 不经 shell 执行启动器；`file` 已是可直接 spawn 的目标（Windows .cmd 已包成 cmd.exe）。 */
  run: (
    file: string,
    args: string[],
    options: { timeoutMs: number; windowsVerbatimArguments: boolean },
  ) => Promise<NekLocatorCommandResult>;
  log?: { warn: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
}

export interface NekLocatorOptions {
  /** 设置里的启动器路径（最高优先级）。 */
  configuredPath?: string;
  /** `gui-info` 的等待上限，默认 15 s。 */
  timeoutMs?: number;
  /** 协议版本要求，默认 `NEK_GUI_PROTOCOL_VERSION`。 */
  requiredProtocolVersion?: number;
  /** 缓存条目上限，默认 8。 */
  maxCachedLaunchers?: number;
}

export interface NekLocatorResult {
  launcherPath: string;
  info: NekGuiInfo;
  /** 是否命中缓存（诊断用）。 */
  cached: boolean;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  result: NekLocatorResult;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CACHED = 8;
/** Windows 上 PATH 查找要试的扩展名（`nek` 裸名可能是 shell 脚本）。 */
const WINDOWS_LAUNCHER_NAMES = ["nek.cmd", "nek.exe", "nek.bat", "nek"];
const POSIX_LAUNCHER_NAMES = ["nek"];

/** 本机 deps 的默认实现（Node fs / child_process）。 */
export function createNekLocatorDeps(): NekLocatorDeps {
  return {
    platform: process.platform,
    env: process.env,
    homedir: homedir(),
    statFile: async (path) => {
      try {
        const info = await stat(path);
        if (!info.isFile()) return null;
        return { mtimeMs: info.mtimeMs, size: info.size };
      } catch {
        return null;
      }
    },
    run: (file, args, options) =>
      new Promise((resolve) => {
        execFile(
          file,
          args,
          {
            timeout: options.timeoutMs,
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
            windowsVerbatimArguments: options.windowsVerbatimArguments,
          },
          (error, stdout, stderr) => {
            const code =
              error &&
              typeof error === "object" &&
              "code" in error &&
              typeof error.code === "number"
                ? error.code
                : error
                  ? null
                  : 0;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          },
        );
      }),
  };
}

/** 判断一个路径是否可执行（存在且是文件）。 */
async function findExisting(deps: NekLocatorDeps, path: string): Promise<string | null> {
  return (await deps.statFile(path)) ? path : null;
}

/** 路径语义（分隔符、PATH 分隔符）跟随 `deps.platform`，不取决于运行定位器的宿主。 */
function platformPath(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

/** PATH 里的候选启动器。 */
async function findOnPath(deps: NekLocatorDeps): Promise<string | null> {
  const names = deps.platform === "win32" ? WINDOWS_LAUNCHER_NAMES : POSIX_LAUNCHER_NAMES;
  const { delimiter, join } = platformPath(deps.platform);
  const pathValue = deps.env.PATH ?? deps.env.Path ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const found = await findExisting(deps, join(dir, name));
      if (found) return found;
    }
  }
  return null;
}

/** 各平台的默认安装位置。 */
function defaultInstallCandidates(deps: NekLocatorDeps): string[] {
  const { join } = platformPath(deps.platform);
  if (deps.platform === "win32") {
    const localAppData = deps.env.LOCALAPPDATA ?? join(deps.homedir, "AppData", "Local");
    return [join(localAppData, "nekcode", "bin", "nek.cmd")];
  }
  return [join(deps.homedir, ".local", "bin", "nek")];
}

/**
 * 可直接交给 execFile/spawn 的启动器命令。
 *
 * Windows 上 `.cmd`/`.bat` 不是可执行映像，必须交给 `cmd.exe /d /s /c`。
 * 引用整个命令串（`/s` 的语义是"去掉最外层引号后原样交给 cmd"），避免空格路径被拆开；
 * 与 Node 自己的 `shell: true` 实现一致。此时 `windowsVerbatimArguments` 为 true：
 * 命令串已按 cmd 规则加好引号，必须原样传递，否则 Node 会再把引号转义成 `\"`，
 * cmd 报"文件名、目录名或卷标语法不正确"。
 */
export function toLocatorCommand(
  launcherPath: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  options: { comSpec?: string } = {},
): { file: string; args: string[]; windowsVerbatimArguments: boolean } {
  if (platform === "win32" && /\.(cmd|bat)$/iu.test(launcherPath)) {
    const commandLine = [launcherPath, ...args].map((part) => `"${part}"`).join(" ");
    return {
      file: options.comSpec ?? process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { file: launcherPath, args: [...args], windowsVerbatimArguments: false };
}

/** 解析 `gui-info` 的 stdout：先整体解析，失败再按行从后往前找（容忍安装脚本的噪声输出）。 */
export function parseNekGuiInfo(stdout: string): NekGuiInfo | null {
  const trimmed = stdout.replace(/^\uFEFF/u, "").trim();
  if (trimmed === "") return null;
  const candidates = [
    trimmed,
    ...trimmed
      .split("\n")
      .map((line) => line.trim())
      .reverse(),
  ];
  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      return validateNekGuiInfo(parsed);
    } catch {
      continue;
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** `gui-info` 的形状校验：缺字段就是安装不完整，按 `failed` 处理。 */
export function validateNekGuiInfo(value: unknown): NekGuiInfo | null {
  if (!isRecord(value)) return null;
  const node = value.node;
  const launch = value.launch;
  if (typeof value.protocolVersion !== "number") return null;
  if (typeof value.nekVersion !== "string" || typeof value.piVersion !== "string") return null;
  if (!isRecord(node) || typeof node.path !== "string" || typeof node.version !== "string")
    return null;
  if (!isRecord(launch) || !Array.isArray(launch.args)) return null;
  if (!launch.args.every((arg) => typeof arg === "string")) return null;
  if (typeof value.agentDir !== "string" || typeof value.sessionDir !== "string") return null;
  if (typeof value.platform !== "string" || typeof value.arch !== "string") return null;
  return value as unknown as NekGuiInfo;
}

export class NekLocator {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly deps: NekLocatorDeps = createNekLocatorDeps(),
    private readonly options: NekLocatorOptions = {},
  ) {}

  /** 清空缓存（设置里改了启动器路径、或用户点了"重新检测"）。 */
  invalidate(): void {
    this.cache.clear();
  }

  /** 解析启动器路径：配置 → PATH → 平台默认位置。 */
  async resolveLauncherPath(): Promise<string> {
    const configured = this.options.configuredPath?.trim();
    if (configured) {
      const found = await findExisting(this.deps, configured);
      if (found) return found;
      throw new NekLocatorError(
        "not_found",
        `configured nek launcher does not exist: ${configured}`,
        {
          launcherPath: configured,
        },
      );
    }
    const onPath = await findOnPath(this.deps);
    if (onPath) return onPath;
    for (const candidate of defaultInstallCandidates(this.deps)) {
      const found = await findExisting(this.deps, candidate);
      if (found) return found;
    }
    throw new NekLocatorError(
      "not_found",
      "nek launcher not found; configure its path or install nekcode",
    );
  }

  /** 找到启动器并读 `gui-info`（命中缓存则不执行）。 */
  async locate(): Promise<NekLocatorResult> {
    const launcherPath = await this.resolveLauncherPath();
    const fileInfo = await this.deps.statFile(launcherPath);
    if (!fileInfo) {
      throw new NekLocatorError("not_found", `nek launcher disappeared: ${launcherPath}`, {
        launcherPath,
      });
    }
    const cached = this.cache.get(launcherPath);
    if (cached && cached.mtimeMs === fileInfo.mtimeMs && cached.size === fileInfo.size) {
      return { ...cached.result, cached: true };
    }
    const info = await this.runGuiInfo(launcherPath);
    const required = this.options.requiredProtocolVersion ?? NEK_GUI_PROTOCOL_VERSION;
    if (info.protocolVersion !== required) {
      throw new NekLocatorError(
        "incompatible",
        `nek ${info.nekVersion} speaks protocol ${info.protocolVersion}, this app requires ${required}; update nek`,
        {
          launcherPath,
          actualProtocolVersion: info.protocolVersion,
          expectedProtocolVersion: required,
          actualNekVersion: info.nekVersion,
        },
      );
    }
    if (!isNekGuiVersionSupported(info.nekVersion)) {
      throw new NekLocatorError(
        "incompatible",
        `nek ${info.nekVersion} cannot provide complete GUI tool streams; update nek to ${NEK_GUI_MIN_VERSION} or newer`,
        {
          launcherPath,
          actualProtocolVersion: info.protocolVersion,
          expectedProtocolVersion: required,
          actualNekVersion: info.nekVersion,
          requiredNekVersion: NEK_GUI_MIN_VERSION,
        },
      );
    }
    const result: NekLocatorResult = { launcherPath, info, cached: false };
    this.remember(launcherPath, { mtimeMs: fileInfo.mtimeMs, size: fileInfo.size, result });
    return result;
  }

  private remember(launcherPath: string, entry: CacheEntry): void {
    const maxCached = Math.max(1, this.options.maxCachedLaunchers ?? DEFAULT_MAX_CACHED);
    this.cache.delete(launcherPath);
    this.cache.set(launcherPath, entry);
    while (this.cache.size > maxCached) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  private async runGuiInfo(launcherPath: string): Promise<NekGuiInfo> {
    const command = toLocatorCommand(launcherPath, ["gui-info", "--json"], this.deps.platform, {
      comSpec: this.deps.env.ComSpec,
    });
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.deps.log?.debug?.("running nek gui-info", command.file, command.args);
    let result: NekLocatorCommandResult;
    try {
      result = await this.deps.run(command.file, command.args, {
        timeoutMs,
        windowsVerbatimArguments: command.windowsVerbatimArguments,
      });
    } catch (error) {
      throw new NekLocatorError("failed", `failed to run ${launcherPath} gui-info --json`, {
        launcherPath,
        stderrSummary: summarizeStderr(error instanceof Error ? error.message : String(error)),
      });
    }
    if (result.code !== 0) {
      const stderrSummary = summarizeStderr(result.stderr);
      // 把 stderr 摘要带进消息：界面只显示 message，"Unknown option: --json"（nek 过旧）
      // 这类原因必须让用户直接看到。
      const reason = lastMeaningfulLine(stderrSummary);
      throw new NekLocatorError(
        "failed",
        `${launcherPath} gui-info --json exited with ${result.code ?? "no code"}${reason ? `: ${reason}` : ""}`,
        { launcherPath, stderrSummary },
      );
    }
    const info = parseNekGuiInfo(result.stdout);
    if (!info) {
      throw new NekLocatorError(
        "failed",
        `${launcherPath} gui-info --json returned an unexpected payload`,
        {
          launcherPath,
          stderrSummary: summarizeStderr(result.stderr || result.stdout),
        },
      );
    }
    return info;
  }
}

/** stderr 摘要：最多 20 行 / 2 KB，供错误消息与日志使用。 */
export function summarizeStderr(stderr: string, maxLines = 20, maxChars = 2048): string {
  const lines = stderr.split("\n").filter((line) => line.trim() !== "");
  const tail = lines.slice(-maxLines).join("\n");
  return tail.length > maxChars ? `${tail.slice(0, maxChars)}…` : tail;
}

/** stderr 中最后一条有意义的行（跳过 Node 运行时警告），最长 200 字符。 */
function lastMeaningfulLine(stderrSummary: string): string {
  const lines = stderrSummary
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^\(node:\d+\)|^\(Use `node --trace-/u.test(line));
  const last = lines.at(-1) ?? "";
  return last.length > 200 ? `${last.slice(0, 200)}…` : last;
}

/** 供启动器可达性探测用（测试与"检测安装"按钮）。 */
export async function isExecutableFile(deps: NekLocatorDeps, path: string): Promise<boolean> {
  if (await deps.statFile(path)) return true;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
