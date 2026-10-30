import type { Readable, Writable } from "node:stream";
import type { NekRpcProcessHandle } from "../../../services/src/nek-agent/nekRpcClient.js";
import type {
  NekConfigHostExecutor,
  NekHostDirEntry,
  NekHostStat,
} from "../../../services/src/nek-config-api/hostExecutor.js";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

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

const REMOTE_SCRIPT = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const [operation, ...values] = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
const result = (value) => process.stdout.write(JSON.stringify({ ok: true, value }));
try {
  if (operation === "paths") {
    const home = os.homedir();
    const configured = (process.env.NEK_CODING_AGENT_DIR || "").trim();
    result({ home, agentDir: configured ? path.resolve(configured.replace(/^~(?=\\/|$)/, home)) : path.join(home, ".nek", "agent") });
  } else if (operation === "read") {
    try { result({ content: fs.readFileSync(values[0], "utf8") }); }
    catch (error) { if (error && error.code === "ENOENT") result({ content: null }); else throw error; }
  } else if (operation === "write") {
    const target = values[0];
    const temporary = `${target}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.writeFileSync(temporary, Buffer.from(values[1], "base64")); fs.renameSync(temporary, target); }
    catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
    result(null);
  } else if (operation === "stat") {
    try { const info = fs.statSync(values[0]); result({ mtimeMs: info.mtimeMs, size: info.size, isDirectory: info.isDirectory() }); }
    catch (error) { if (error && error.code === "ENOENT") result(null); else throw error; }
  } else if (operation === "listDir") {
    try { result(fs.readdirSync(values[0], { withFileTypes: true }).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))); }
    catch (error) { if (error && error.code === "ENOENT") result([]); else throw error; }
  } else if (operation === "remove") {
    try { fs.unlinkSync(values[0]); } catch (error) { if (!error || error.code !== "ENOENT") throw error; }
    result(null);
  } else if (operation === "rename") {
    fs.renameSync(values[0], values[1]);
    result(null);
  } else {
    throw new Error(`unknown remote config operation: ${operation}`);
  }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}`;

async function runJson(
  connection: NekRemoteConfigConnection,
  operation: string,
  values: string[] = [],
): Promise<unknown> {
  const payload = Buffer.from(JSON.stringify([operation, ...values]), "utf8").toString("base64");
  const process = await connection.exec(`node -e ${shellQuote(REMOTE_SCRIPT)} ${shellQuote(payload)}`);
  const stdout = { value: "" };
  const stderr = { value: "" };
  process.stdout.on("data", (chunk) => appendOutput(stdout, chunk));
  process.stderr.on("data", (chunk) => appendOutput(stderr, chunk));
  const code = await new Promise<number>((resolve) => {
    process.onClose((exitCode) => resolve(exitCode));
  });
  if (code !== 0) throw new Error(stderr.value || `远端配置操作失败，退出码 ${code}`);
  let parsed: RemoteJsonResult;
  try {
    parsed = JSON.parse(stdout.value) as RemoteJsonResult;
  } catch (error) {
    throw new Error(`远端配置操作返回无效 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed.ok) throw new Error(parsed.error ?? "远端配置操作失败");
  return parsed.value;
}

function asStat(value: unknown): NekHostStat | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null) throw new Error("远端 stat 返回无效数据");
  const stat = value as Partial<NekHostStat>;
  if (
    typeof stat.mtimeMs !== "number" ||
    typeof stat.size !== "number" ||
    typeof stat.isDirectory !== "boolean"
  )
    throw new Error("远端 stat 返回无效数据");
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

export async function readRemoteConfigPaths(
  connection: NekRemoteConfigConnection,
): Promise<{ home: string; agentDir: string }> {
  const value = await runJson(connection, "paths");
  if (typeof value !== "object" || value === null) throw new Error("远端路径信息无效");
  const paths = value as { home?: unknown; agentDir?: unknown };
  if (typeof paths.home !== "string" || typeof paths.agentDir !== "string")
    throw new Error("远端路径信息无效");
  return { home: paths.home, agentDir: paths.agentDir };
}

export function createRemoteNekConfigHostExecutor(options: {
  id: string;
  home: string;
  agentDir: string;
  connection: NekRemoteConfigConnection;
  nekCommand?: string;
}): NekConfigHostExecutor {
  const { connection } = options;
  return {
    id: options.id,
    homeDir: () => options.home,
    agentDir: () => options.agentDir,
    readFile: async (path) => {
      const value = await runJson(connection, "read", [path]);
      if (typeof value !== "object" || value === null) throw new Error("远端 readFile 返回无效数据");
      const content = (value as { content?: unknown }).content;
      if (content !== null && typeof content !== "string") throw new Error("远端 readFile 返回无效数据");
      return content;
    },
    writeFileAtomic: async (path, content) => {
      await runJson(connection, "write", [path, Buffer.from(content, "utf8").toString("base64")]);
    },
    stat: async (path) => asStat(await runJson(connection, "stat", [path])),
    listDir: async (path) => asDirEntries(await runJson(connection, "listDir", [path])),
    remove: async (path) => {
      await runJson(connection, "remove", [path]);
    },
    rename: async (from, to) => {
      await runJson(connection, "rename", [from, to]);
    },
    spawnNek: async (args): Promise<NekRpcProcessHandle> => {
      const command = options.nekCommand ?? "nek";
      const stream = await connection.exec(
        [command, ...args].map((argument) => shellQuote(argument)).join(" "),
      );
      const onExit = (listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void) => {
        const subscription = stream.onClose((code) => listener({ code, signal: null }));
        return () => subscription.dispose();
      };
      return {
        stdin: stream.stdin as unknown as Writable,
        stdout: stream.stdout as unknown as Readable,
        stderr: stream.stderr as unknown as Readable,
        kill: () => stream.signal?.("SIGTERM"),
        onExit,
      };
    },
  };
}
