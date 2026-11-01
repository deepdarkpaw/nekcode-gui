/**
 * 本机安装 / 更新 nek 的子进程辅助：安装命令、输出逐行回传（有界缓冲）与结果映射。
 * 从 `desktopMainIpcNekHost.ts` 拆出，设置宿主服务只负责编排。
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { NekInstallOptions, NekInstallResult } from "@zcode/shared/nek-protocol";
import { buildNekInstallCommand, buildNekInstallPowerShellCommand } from "@zcode/server/remote";

export type LogListener = (line: string) => void;

const MAX_LOG_BYTES = 64 * 1024;

export function mapInstallResult(result: {
  ok: boolean;
  cancelled: boolean;
  stderrSummary: string;
  exitCode: number | null;
  manualCommand?: string;
}): NekInstallResult {
  if (result.ok) {
    return { ok: true, version: "unknown" };
  }
  return {
    ok: false,
    cancelled: result.cancelled,
    message: result.stderrSummary || `installer exited with ${result.exitCode ?? "no code"}`,
    manualCommand: result.manualCommand ?? "",
  };
}

function appendLines(buffer: { value: string }, chunk: Buffer | string, onLog: LogListener): void {
  buffer.value = `${buffer.value}${chunk.toString()}`.slice(-MAX_LOG_BYTES);
  const lines = buffer.value.split(/\r?\n/u);
  buffer.value = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim()) onLog(line);
  }
}

/** 本机安装 nek 的命令：Windows 走官方 `install.ps1`，其他平台走 `install.sh`。 */
export function localInstallInvocation(options: NekInstallOptions): {
  file: string;
  args: string[];
  manualCommand: string;
} {
  if (process.platform === "win32") {
    const command = buildNekInstallPowerShellCommand(options);
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      manualCommand: command,
    };
  }
  const command = buildNekInstallCommand(options);
  return { file: "sh", args: ["-lc", command], manualCommand: command };
}

export async function runLocalCommand(
  command: string,
  args: string[],
  signal: AbortSignal,
  onLog: LogListener,
  options: { windowsVerbatimArguments?: boolean } = {},
): Promise<{ code: number | null; cancelled: boolean; output: string }> {
  const child = spawn(command, args, {
    cwd: homedir(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
  });
  const output = { value: "" };
  const abort = () => child.kill("SIGINT");
  signal.addEventListener("abort", abort, { once: true });
  child.stdout.on("data", (chunk: Buffer | string) => appendLines(output, chunk, onLog));
  child.stderr.on("data", (chunk: Buffer | string) => appendLines(output, chunk, onLog));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  signal.removeEventListener("abort", abort);
  if (output.value.trim()) onLog(output.value);
  return { code, cancelled: signal.aborted, output: output.value };
}
