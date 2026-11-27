/**
 * 远程目标的配置执行器：把 `NekConfigHostExecutor` 的原语搬到达成连接的远端机器上执行。
 *
 * 远端没有本地 Node fs 可用，所以每次操作都通过 `exec` 在远端跑一段等价脚本：
 * 读、`.tmp` + rename 原子写、stat、listDir、remove、rename，以及 settings 用的
 * `proper-lockfile` 同款 `<file>.lock` 目录锁（与远端 nek 进程互斥）。
 *
 * 远端运行时由 {@link detectRemoteConfigRuntime} 显式给出：Node 与启动参数取自远端
 * `nek gui-info`（运行 nek 的那份 Node，版本有保证），home / agentDir 在与 nek 进程相同的
 * `sh -l` 环境里探测。不在 PATH 上猜 Node：系统自带的旧 Node（例如 v12）跑不了配置脚本。
 */
import type { Readable, Writable } from "node:stream";
import type { NekGuiInfo } from "@zcode/shared/nek-protocol";
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

/** 远端配置运行环境：连接时探测一次，`createRemoteNekConfigHostExecutor` 复用。 */
interface NekRemoteConfigRuntime {
  home: string;
  agentDir: string;
  /** 远端运行 nek 的 Node（`gui-info` 的 `node.path`），也用来执行配置读写脚本。 */
  node: string;
  /** `gui-info` 的 `launch.args`：原样放在 nek 参数之前。 */
  launchArgs: string[];
  /** 远端平台（`gui-info` 的 `platform`）。 */
  platform: string;
}

interface RemoteJsonResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** POSIX 单引号转义：`'` → `'"'"'`，可以安全地再套一层 `sh -c`。 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function appendOutput(buffer: { value: string }, chunk: unknown): void {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  buffer.value += text;
  if (Buffer.byteLength(buffer.value, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error("远端配置操作输出超过 4 MB 上限");
  }
}

/**
 * 远端目录探测（纯 shell）：输出 `$HOME` 与 `$NEK_CODING_AGENT_DIR` 两行。
 * 与 {@link createRemoteNekConfigHostExecutor} 启动 nek 用同一个 `sh -l` 环境，两边的 agentDir 一致。
 */
const REMOTE_PROBE_SCRIPT = 'printf "%s\\n" "${HOME-}" "${NEK_CODING_AGENT_DIR-}"';

const REMOTE_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
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
      // models.json / settings.json / mcp.json 可能带密钥：新文件只给属主读写，已有文件保留原权限。
      let mode = 0o600;
      try { mode = fs.statSync(target).mode & 0o7777; } catch (error) { if (!ignoredMissing(error)) throw error; }
      try {
        fs.writeFileSync(temporary, Buffer.from(values[1], "base64"), { mode });
        fs.chmodSync(temporary, mode);
        fs.renameSync(temporary, target);
      } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
      write(null);
    } else if (operation === "resourceKind") {
      try {
        const info = fs.lstatSync(values[0]);
        write(info.isDirectory() ? "directory" : info.isFile() ? "file" : "other");
      } catch (error) { if (ignoredMissing(error)) write(null); else throw error; }
    } else if (operation === "resourceRead") {
      const [target, limit] = values;
      const maxBytes = Number(limit);
      const file = fs.openSync(target, "r");
      try {
        const buffer = Buffer.alloc(maxBytes + 1);
        let size = 0;
        while (size < buffer.length) {
          const count = fs.readSync(file, buffer, size, buffer.length - size, size);
          if (count === 0) break;
          size += count;
        }
        if (size > maxBytes) throw new Error("Resource exceeds " + (maxBytes / 1024) + " KB: " + target);
        write({ content: buffer.toString("utf8", 0, size) });
      } finally { fs.closeSync(file); }
    } else if (operation === "resourceWrite") {
      const [target, content, createOnly] = values;
      const temporary = target + "." + randomUUID() + ".tmp";
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(temporary, Buffer.from(content, "base64"), { flag: "wx" });
      try {
        if (createOnly === "true") fs.linkSync(temporary, target);
        else fs.renameSync(temporary, target);
      } finally {
        try { fs.unlinkSync(temporary); } catch (error) { if (!ignoredMissing(error)) throw error; }
      }
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
  // ssh2 可能先报退出码、后派发最后一段输出；读完两路输出再解析 JSON。
  const [code] = await Promise.all([
    new Promise<number>((resolve) => stream.onClose(resolve)),
    waitForEnd(stream.stdout),
    waitForEnd(stream.stderr),
  ]);
  if (outputError) throw outputError;
  return { stdout: stdout.value, stderr: stderr.value, code };
}

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

/**
 * 远端配置运行时：Node 与启动参数来自已检测通过的 `gui-info`，home / agentDir 由 shell 探测。
 * Node 不能在 PATH 上另找——那可能是系统的旧版本，跟运行 nek 的不是同一份。
 */
export async function detectRemoteConfigRuntime(
  connection: NekRemoteConfigConnection,
  nek: Pick<NekGuiInfo, "node" | "launch" | "platform">,
): Promise<NekRemoteConfigRuntime> {
  const result = await runCommand(connection, `sh -lc ${shellQuote(REMOTE_PROBE_SCRIPT)}`);
  if (result.code !== 0) {
    throw new Error(result.stderr || `远端环境探测失败，退出码 ${result.code}`);
  }
  const [home = "", configuredAgentDir = ""] = result.stdout.split(/\r?\n/u);
  if (!home.trim()) throw new Error("远端环境探测失败：拿不到 $HOME");
  const agentDir = configuredAgentDir.trim()
    ? configuredAgentDir.trim().replace(/^~(?=\/|$)/u, home.trim())
    : `${home.trim()}/.nek/agent`;
  if (!nek.node.path.trim()) {
    throw new Error(`远端 nek gui-info 没有给出 Node 路径，无法读写 ${agentDir} 下的 nek 配置`);
  }
  return {
    home: home.trim(),
    agentDir,
    node: nek.node.path,
    launchArgs: [...nek.launch.args],
    platform: nek.platform,
  };
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

interface CreateRemoteNekConfigHostExecutorOptions {
  id: string;
  runtime: NekRemoteConfigRuntime;
  connection: NekRemoteConfigConnection;
}

export function createRemoteNekConfigHostExecutor(
  options: CreateRemoteNekConfigHostExecutorOptions,
): NekConfigHostExecutor {
  const { connection, runtime } = options;
  const pathOnTarget = (path: string) =>
    process.platform === "win32" ? path.replaceAll("\\", "/") : path;
  // 主进程在 Windows 上拼出的路径分隔符不是远端 POSIX 文件名的一部分。
  const run = async (operation: string, path: string, ...args: string[]): Promise<unknown> =>
    await runJson(connection, runtime.node, operation, [pathOnTarget(path), ...args]);
  const writeFileAtomic = async (path: string, content: string): Promise<void> => {
    await run("write", path, Buffer.from(content, "utf8").toString("base64"));
  };
  const readFile = async (path: string): Promise<string | null> =>
    asContent(await run("read", path));

  const lock: NekHostLock = {
    runLocked: async (path, critical, atomic) => {
      await run("lock", path, String(LOCK_TIMEOUT_MS));
      let failure: unknown;
      try {
        let current: string | null;
        if (atomic) {
          const info = asStat(await run("stat", path));
          current = info
            ? asContent(await run("resourceRead", path, String(atomic.maxBytes)))
            : null;
        } else current = await readFile(path);
        const next = critical(current ?? undefined);
        if (atomic && next !== undefined && Buffer.byteLength(next) > atomic.maxBytes)
          throw new Error("Broadcast metadata size exceeded");
        if (next !== undefined) await writeFileAtomic(path, next);
      } catch (error) {
        failure = error;
      }
      try {
        await run("unlock", path);
      } catch (releaseError) {
        // 释放失败不能掩盖临界区里的真实错误；两者都失败时两个都要报出来。
        throw failure === undefined
          ? releaseError
          : new AggregateError([failure, releaseError], `远端配置锁释放失败: ${path}`);
      }
      if (failure !== undefined) throw failure;
    },
  };

  // 与 gui-info 的约定一致：直接用那份 Node + launch.args 启动，不再经 PATH 上的启动器挑 Node。
  const spawnNek = async (args: readonly string[]): Promise<NekRpcProcessHandle> => {
    const command = [runtime.node, ...runtime.launchArgs, ...args].map((value) =>
      shellQuote(value),
    );
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
    platform: () => runtime.platform,
    homeDir: () => runtime.home,
    agentDir: () => runtime.agentDir,
    readFile,
    writeFileAtomic,
    stat: async (path) => asStat(await run("stat", path)),
    resourceEntryKind: async (path) => {
      const result = await run("resourceKind", path);
      if (result === "directory" || result === "file" || result === "other" || result === null)
        return result;
      throw new Error("远端资源文件类型无效");
    },
    readResourceFile: async (path, maxBytes) => {
      const content = asContent(await run("resourceRead", path, String(maxBytes)));
      if (content === null) throw new Error(`Missing resource: ${path}`);
      return content;
    },
    writeResourceFile: async (path, content, createOnly) => {
      await run(
        "resourceWrite",
        path,
        Buffer.from(content, "utf8").toString("base64"),
        String(createOnly),
      );
    },
    listDir: async (path) => asDirEntries(await run("listDir", path)),
    remove: async (path) => {
      await run("remove", path);
    },
    rename: async (from, to) => {
      await run("rename", from, pathOnTarget(to));
    },
    spawnNek,
    lock,
  };
}
