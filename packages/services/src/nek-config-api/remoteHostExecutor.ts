/**
 * 远程目标的配置执行器：把 `NekConfigHostExecutor` 的原语搬到达成连接的远端机器上执行。
 *
 * 远端没有本地 Node fs 可用，所以每次操作都通过 `exec` 在远端跑一段等价脚本：
 * 读、`.tmp` + rename 原子写、stat、listDir、remove、rename，以及 settings 用的
 * `proper-lockfile` 同款 `<file>.lock` 目录锁（与远端 nek 进程互斥）。
 *
 * 远端运行时（home / agentDir / node）由 {@link detectRemoteConfigRuntime} 显式探测：
 * 探不到 node 就报错，不猜路径、不静默降级。
 */
import type { Readable, Writable } from "node:stream";
import type { NekRpcProcessHandle } from "../nek-agent/nekRpcClient.js";
import type { NekConfigHostExecutor, NekHostDirEntry, NekHostLock } from "./hostExecutor.js";
import type { NekHostStat } from "./revision.js";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 15_000;
/** 与 `proper-lockfile` 的 stale 默认值一致：超过 10 s 没被 touch 的锁可以抢占。 */
const LOCK_STALE_MS = 10_000;

type RemoteCloseSubscription = { dispose(): void };

export interface NekRemoteConfigExecStream {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  signal?: (signal: string) => void;
  onClose: (listener: (code: number) => void) => RemoteCloseSubscription;
}

export interface NekRemoteConfigConnection {
  exec(command: string): Promise<NekRemoteConfigExecStream>;
}

/** 远端配置运行环境：探测一次，`createRemoteNekConfigHostExecutor` 复用。 */
export interface NekRemoteConfigRuntime {
  home: string;
  agentDir: string;
  /** 远端 node 可执行文件的绝对路径（或 PATH 上的 `node`）。 */
  node: string;
}

interface RemoteJsonResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\\"'\\\"'") + "'";
}

function appendOutput(buffer: { value: string }, chunk: unknown): void {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  buffer.value += text;
  if (Buffer.byteLength(buffer.value, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error("远端配置操作输出超过 4 MB 上限");
  }
}

/**
 * 远端运行时探测（纯 shell，不依赖 node）。
 *
 * 输出三行：`$HOME`、`$NEK_CODING_AGENT_DIR`、node 可执行文件路径（可能在 PATH 上，
 * 也可能是 nek 官方安装脚本放进 `~/.nek/node` 的那份）。
 */
const REMOTE_PROBE_SCRIPT = [
  'printf "%s\\n" "${HOME-}" "${NEK_CODING_AGENT_DIR-}"',
  "if command -v node >/dev/null 2>&1; then command -v node",
  'elif [ -x "$HOME/.nek/node/bin/node" ]; then printf "%s\\n" "$HOME/.nek/node/bin/node"',
  'elif [ -x /usr/local/bin/node ]; then printf "%s\\n" /usr/local/bin/node',
  'elif [ -x /usr/bin/node ]; then printf "%s\\n" /usr/bin/node',
  "fi",
].join("; ");

const REMOTE_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const [operation, ...values] = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
const write = (value) => process.stdout.write(JSON.stringify({ ok: true, value }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lockPath = (target) => target + ".lock";
const ignoredMissing = (error) => error && error.code === "ENOENT";

async function acquire(target, timeoutMs) {
  const directory = lockPath(target);
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(directory);
      return;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      // 与 proper-lockfile 一致：持有者长时间没 touch 就按 stale 抢占。
      let age = 0;
      try { age = Date.now() - fs.statSync(directory).mtimeMs; } catch (statError) {
        if (ignoredMissing(statError)) continue;
        throw statError;
      }
      if (age > ${LOCK_STALE_MS}) {
        try { fs.rmdirSync(directory); } catch {} 
        continue;
      }
      if (Date.now() > deadline) throw new Error("远端 settings 锁等待超时：" + target);
      await sleep(50);
    }
  }
}

function release(target) {
  try { fs.rmdirSync(lockPath(target)); } catch (error) { if (!ignoredMissing(error)) throw error; }
}

(async () => {
  try {
    if (operation === "read") {
      try { write({ content: fs.readFileSync(values[0], "utf8") }); }
      catch (error) { if (ignoredMissing(error)) write({ content: null }); else throw error; }
    } else if (operation === "write") {
      const target = values[0];
      const temporary = target + ".tmp";
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try { fs.writeFileSync(temporary, Buffer.from(values[1], "base64")); fs.renameSync(temporary, target); }
      catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
      write(null);
    } else if (operation === "stat") {
      try { const info = fs.statSync(values[0]); write({ mtimeMs: info.mtimeMs, size: info.size, isDirectory: info.isDirectory() }); }
      catch (error) { if (ignoredMissing(error)) write(null); else throw error; }
    } else if (operation === "listDir") {
      try { write(fs.readdirSync(values[0], { withFileTypes: true }).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))); }
      catch (error) { if (ignoredMissing(error)) write([]); else throw error; }
    } else if (operation === "remove") {
      try { fs.unlinkSync(values[0]); } catch (error) { if (!ignoredMissing(error)) throw error; }
      write(null);
    } else if (operation === "rename") {
      fs.renameSync(values[0], values[1]);
      write(null);
    } else if (operation === "lock") {
      await acquire(values[0], Number(values[1]) || ${LOCK_TIMEOUT_MS});
      write(null);
    } else if (operation === "unlock") {
      release(values[0]);
      write(null);
    } else {
      throw new Error("unknown remote config operation: " + operation);
    }
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
})();`;

async function runCommand(
  connection: NekRemoteConfigConnection,
  command: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const stream = await connection.exec(command);
  const stdout = { value: "" };
  const stderr = { value: "" };
  let outputError: Error | undefined;
  const collect = (buffer: { value: string }, chunk: unknown): void => {
    if (outputError) return;
    try {
      appendOutput(buffer, chunk);
    } catch (error) {
      outputError = error instanceof Error ? error : new Error(String(error));
    }
  };
  stream.stdout.on("data", (chunk) => collect(stdout, chunk));
  stream.stderr.on("data", (chunk) => collect(stderr, chunk));
  const code = await new Promise<number>((resolve) => stream.onClose(resolve));
  if (outputError) throw outputError;
  return { stdout: stdout.value, stderr: stderr.value, code };
}

/** 探测远端运行时；探不到 node 时明确报错（配置读写没有远端解释器可用）。 */
export async function detectRemoteConfigRuntime(
  connection: NekRemoteConfigConnection,
): Promise<NekRemoteConfigRuntime> {
  const result = await runCommand(connection, `sh -lc ${shellQuote(REMOTE_PROBE_SCRIPT)}`);
  if (result.code !== 0) {
    throw new Error(result.stderr || `远端环境探测失败，退出码 ${result.code}`);
  }
  const [home = "", configuredAgentDir = "", node = ""] = result.stdout.split(/\r?\n/u);
  if (!home.trim()) throw new Error("远端环境探测失败：拿不到 $HOME");
  const agentDir = configuredAgentDir.trim()
    ? configuredAgentDir.trim().replace(/^~(?=\/|$)/u, home.trim())
    : `${home.trim()}/.nek/agent`;
  if (!node.trim()) {
    throw new Error(
      `远端缺少 Node 运行时（PATH、~/.nek/node/bin/node 都没有），无法读写 ${agentDir} 下的 nek 配置`,
    );
  }
  return { home: home.trim(), agentDir, node: node.trim() };
}

async function runJson(
  connection: NekRemoteConfigConnection,
  node: string,
  operation: string,
  values: string[] = [],
): Promise<unknown> {
  const payload = Buffer.from(JSON.stringify([operation, ...values]), "utf8").toString("base64");
  const result = await runCommand(
    connection,
    `${shellQuote(node)} -e ${shellQuote(REMOTE_SCRIPT)} ${shellQuote(payload)}`,
  );
  if (result.code !== 0)
    throw new Error(result.stderr || `远端配置操作失败，退出码 ${result.code}`);
  let parsed: RemoteJsonResult;
  try {
    parsed = JSON.parse(result.stdout) as RemoteJsonResult;
  } catch (error) {
    throw new Error(
      `远端配置操作返回无效 JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed.ok) throw new Error(parsed.error ?? "远端配置操作失败");
  return parsed.value;
}

function asStat(value: unknown): NekHostStat | null {
  if (value === null) return null;
  if (typeof value !== "object") throw new Error("远端 stat 返回无效数据");
  const stat = value as Partial<NekHostStat>;
  if (
    typeof stat.mtimeMs !== "number" ||
    typeof stat.size !== "number" ||
    typeof stat.isDirectory !== "boolean"
  ) {
    throw new Error("远端 stat 返回无效数据");
  }
  return { mtimeMs: stat.mtimeMs, size: stat.size, isDirectory: stat.isDirectory };
}

function asDirEntries(value: unknown): NekHostDirEntry[] {
  if (!Array.isArray(value)) throw new Error("远端 listDir 返回无效数据");
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error("远端目录项无效");
    const item = entry as Partial<NekHostDirEntry>;
    if (typeof item.name !== "string" || typeof item.isDirectory !== "boolean")
      throw new Error("远端目录项无效");
    return { name: item.name, isDirectory: item.isDirectory };
  });
}

function asContent(value: unknown): string | null {
  if (typeof value !== "object" || value === null) throw new Error("远端 readFile 返回无效数据");
  const content = (value as { content?: unknown }).content;
  if (content !== null && typeof content !== "string")
    throw new Error("远端 readFile 返回无效数据");
  return content;
}

export interface CreateRemoteNekConfigHostExecutorOptions {
  id: string;
  runtime: NekRemoteConfigRuntime;
  connection: NekRemoteConfigConnection;
  /** 远端 nek 启动器；缺省用登录 shell 里的 `nek`。 */
  nekCommand?: string;
}

export function createRemoteNekConfigHostExecutor(
  options: CreateRemoteNekConfigHostExecutorOptions,
): NekConfigHostExecutor {
  const { connection, runtime } = options;
  const run = async (operation: string, values: string[] = []): Promise<unknown> =>
    await runJson(connection, runtime.node, operation, values);
  const writeFileAtomic = async (path: string, content: string): Promise<void> => {
    await run("write", [path, Buffer.from(content, "utf8").toString("base64")]);
  };
  const readFile = async (path: string): Promise<string | null> =>
    asContent(await run("read", [path]));

  const lock: NekHostLock = {
    runLocked: async (path, critical) => {
      await run("lock", [path, String(LOCK_TIMEOUT_MS)]);
      let failure: unknown;
      try {
        const next = critical((await readFile(path)) ?? undefined);
        if (next !== undefined) await writeFileAtomic(path, next);
      } catch (error) {
        failure = error;
      }
      try {
        await run("unlock", [path]);
      } catch (releaseError) {
        // 释放失败不能掩盖临界区里的真实错误；两者都失败时两个都要报出来。
        throw failure === undefined
          ? releaseError
          : new AggregateError([failure, releaseError], `远端配置锁释放失败: ${path}`);
      }
      if (failure !== undefined) throw failure;
    },
  };

  const spawnNek = async (args: readonly string[]): Promise<NekRpcProcessHandle> => {
    const command = [options.nekCommand ?? "nek", ...args].map((value) => shellQuote(value));
    const stream = await connection.exec(`sh -lc ${shellQuote(`exec ${command.join(" ")}`)}`);
    const onExit = (
      listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void,
    ) => {
      const subscription = stream.onClose((code) => listener({ code, signal: null }));
      return () => subscription.dispose();
    };
    return {
      stdin: stream.stdin as unknown as Writable,
      stdout: stream.stdout as unknown as Readable,
      stderr: stream.stderr as unknown as Readable,
      kill: () => stream.signal?.("TERM"),
      onExit,
    };
  };

  return {
    id: options.id,
    homeDir: () => runtime.home,
    agentDir: () => runtime.agentDir,
    readFile,
    writeFileAtomic,
    stat: async (path) => asStat(await run("stat", [path])),
    listDir: async (path) => asDirEntries(await run("listDir", [path])),
    remove: async (path) => {
      await run("remove", [path]);
    },
    rename: async (from, to) => {
      await run("rename", [from, to]);
    },
    spawnNek,
    lock,
  };
}
