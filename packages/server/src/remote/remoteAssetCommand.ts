import { finished } from "node:stream/promises";
import type { IRemoteBackend, StdioStream } from "./backend.js";
import { quotePosixShellArg } from "./posixShell.js";

const MAX_COMMAND_OUTPUT = 4_096;
const COMMAND_TIMEOUT_MS = 20_000;

type CommandResult = { code: number; stdout: string; stderr: string };

export class RemoteAssetCommandTimeoutError extends Error {}

async function readBounded(stream: NodeJS.ReadableStream, signal: AbortSignal): Promise<string> {
  let output = "";
  const append = (chunk: Buffer | string) => {
    const remaining = MAX_COMMAND_OUTPUT - output.length;
    if (remaining > 0) output += chunk.slice(0, remaining).toString();
  };
  stream.on("data", append);
  try {
    await finished(stream, { cleanup: true, readable: true, writable: false, signal });
    return output;
  } finally {
    stream.off("data", append);
  }
}

/** 只停止此 exec；外层连接流程仍是 backend 生存期的 owner。 */
function stopCommand(stream: StdioStream): void {
  try {
    // ssh2 只在出站 channel 还打开时发送 signal；随后送 EOF 以兼容忽略 signal 的 sshd。
    stream.signal?.("TERM");
  } finally {
    stream.stdin.end();
  }
}

async function captureCommand(
  backend: IRemoteBackend,
  command: string,
  signal: AbortSignal,
): Promise<CommandResult> {
  const stream = await backend.exec(command);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      stopCommand(stream);
    } catch {
      // 断线时 channel 可能已关闭；保留原取消或超时原因。
    }
  };
  if (signal.aborted) {
    stop();
    signal.throwIfAborted();
  }
  signal.addEventListener("abort", stop, { once: true });
  // ssh2/子进程的 exit 可早于最后一块数据；出口同时等待 stdout/stderr 排空。
  let closeListener: ReturnType<StdioStream["onClose"]> | undefined;
  const closed = new Promise<number>((resolve) => {
    closeListener = stream.onClose(resolve);
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      closed,
      readBounded(stream.stdout, signal),
      readBounded(stream.stderr, signal),
    ]);
    return { code, stdout, stderr };
  } catch (error) {
    stop();
    throw error;
  } finally {
    closeListener?.dispose();
    signal.removeEventListener("abort", stop);
  }
}

/** WSL 会通过默认 shell 重组参数；用紧凑编码保留字面量且不超过 Windows 命令行上限。 */
function encodeWslCommand(script: string): string {
  return `printf %s '${Buffer.from(script).toString("base64")}' | base64 -d | sh`;
}

export async function runRemoteAssetCommand(
  backend: IRemoteBackend,
  script: string,
  signal?: AbortSignal,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(
      new RemoteAssetCommandTimeoutError(`[deploy] remote command exceeded ${timeoutMs / 1000}s`),
    );
  }, timeoutMs);
  const interrupted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
      once: true,
    });
  });
  try {
    const command = backend.kind === "wsl" ? encodeWslCommand(script) : script;
    return await Promise.race([interrupted, captureCommand(backend, command, controller.signal)]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

export async function expectRemoteAssetCommand(
  backend: IRemoteBackend,
  script: string,
  signal: AbortSignal | undefined,
  completion: string,
): Promise<void> {
  const { code, stdout, stderr } = await runRemoteAssetCommand(
    backend,
    `${script}\nprintf '%s\\n' ${quotePosixShellArg(completion)}`,
    signal,
  );
  if (code !== 0 || stdout.trimEnd().split("\n").at(-1) !== completion) {
    throw new Error(
      `[deploy] remote command failed (${completion}, code=${code}): ${stderr.trim()}`,
    );
  }
}
