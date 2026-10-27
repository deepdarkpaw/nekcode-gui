/**
 * 配置目标机器的文件 / 进程执行器。
 *
 * `NekConfigApi` 不假设自己跑在哪台机器上：本机目标用 Node fs 直接读写 `~/.nek/agent`，
 * 远程目标由 host 注入一个通过 SSH（以后）或远程 gui-server 实现的执行器。接口刻意只有
 * 文件与进程两类原语，不含任何策略（revision、锁外写入、`.tmp` 都在上层）。
 *
 * 锁：`settings.json` 必须与 nek 的 `SettingsManager` 用同一把 `proper-lockfile` 锁，
 * 而锁是**持有文件的那台机器**上的本地操作，所以它属于执行器能力。本机实现直接复用
 * `nek-agent/config/nekConfigFs` 的锁（`lockSync(path, { realpath: false })` + 同样的退避）；
 * 远端执行器必须提供等价能力，否则 settings 写入会以 `io` 失败（绝不无锁写入）。
 */
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { NekRpcProcessHandle } from "../nek-agent/nekRpcClient.js";
import { NekLocator } from "../nek-agent/nekLocator.js";
import { spawnNekProcess } from "../nek-agent/nekProcessLauncher.js";
import { createNodeNekConfigFs } from "../nek-agent/config/nekConfigFs.js";
import type { NekHostStat } from "./revision.js";

/** 目录项：名字 + 是否目录（`listDir` 一次给出，避免逐项 stat）。 */
export interface NekHostDirEntry {
  name: string;
  isDirectory: boolean;
}

/** 同步临界区（与 nek 的 `withLock` 同语义：回调内不得 await）。 */
export interface NekHostLock {
  runLocked: (path: string, critical: (current: string | undefined) => string | undefined) => void;
}

export interface NekConfigHostExecutor {
  /** 目标标识（日志与诊断用，例如 `local` / `remote:<connectionId>`）。 */
  readonly id: string;
  /** 读文本；文件不存在返回 `null`（不把"缺失"当错误）。 */
  readFile: (path: string) => Promise<string | null>;
  /** `.tmp` + rename 原子写；父目录按需创建。 */
  writeFileAtomic: (path: string, content: string) => Promise<void>;
  stat: (path: string) => Promise<NekHostStat | null>;
  listDir: (path: string) => Promise<NekHostDirEntry[]>;
  remove: (path: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  /** spawn 一个 `nek` 进程（参数原样追加），返回可直接交给 `NekRpcClient` 的 stdio 句柄。 */
  spawnNek: (args: readonly string[]) => Promise<NekRpcProcessHandle>;
  /** 目标机器的 home 目录（拼 `~/.nek/agent` 用）。 */
  homeDir: () => string;
  /**
   * 目标机器的 nek 配置目录：`~/.nek/agent`，可被**那台机器**的 `NEK_CODING_AGENT_DIR` 覆盖。
   * 必须由执行器解析：远程目标的坏境变量在远端，GUI 进程读不到。
   */
  agentDir: () => string;
  /** settings.json 的独占锁；缺省表示该执行器无法保证并发安全。 */
  lock?: NekHostLock;
}

export interface LocalNekConfigHostExecutorOptions {
  /** 覆盖 home（测试或非默认安装位置）。 */
  home?: string;
  /** 覆盖 agent 目录（`NEK_CODING_AGENT_DIR`）；缺省 `<home>/.nek/agent`。 */
  agentDir?: string;
  /** 环境变量来源；缺省 `process.env`。 */
  env?: Record<string, string | undefined>;
  locator?: NekLocator;
  logger?: { warn: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
}

/** `~/.nek/agent`，可被 `NEK_CODING_AGENT_DIR` 覆盖（与 nek 的 `getAgentDir` 一致）。 */
export function resolveAgentDir(
  home: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const override = env.NEK_CODING_AGENT_DIR?.trim();
  return override ? resolve(expandTilde(override, home)) : join(home, ".nek", "agent");
}

function expandTilde(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

/** 本机执行器：Node fs + `nek gui-info` 定位的启动器。 */
export function createLocalNekConfigHostExecutor(
  options: LocalNekConfigHostExecutorOptions = {},
): NekConfigHostExecutor {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const locator = options.locator ?? new NekLocator();
  const lock = createNodeNekConfigFs().lock;
  const log = options.logger;

  const spawnNek = async (args: readonly string[]): Promise<NekRpcProcessHandle> => {
    const located = await locator.locate();
    const spawned = spawnNekProcess({
      guiInfo: located.info,
      cwd: home,
      args: [...args],
      log,
    });
    return spawned.handle;
  };

  return {
    id: "local",
    homeDir: () => home,
    agentDir: () => resolveAgentDir(home, env),
    readFile: async (path) => {
      try {
        return await readFile(path, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    writeFileAtomic: async (path, content) => {
      const tmpPath = `${path}.tmp`;
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(tmpPath, content, "utf-8");
        await rename(tmpPath, path);
      } catch (error) {
        await unlink(tmpPath).catch(() => undefined);
        throw error;
      }
    },
    stat: async (path) => {
      try {
        const info = await stat(path);
        return { mtimeMs: info.mtimeMs, size: info.size, isDirectory: info.isDirectory() };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    listDir: async (path) => {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    remove: async (path) => {
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
    rename: async (from, to) => {
      await rename(from, to);
    },
    spawnNek,
    lock: {
      runLocked: (path, critical) => {
        lock.run(path, critical);
      },
    },
  };
}

export interface MemoryNekConfigHostExecutorOptions {
  home?: string;
  /** 目标机器的 agent 目录；缺省 `<home>/.nek/agent`。 */
  agentDir?: string;
  files?: Record<string, string>;
  id?: string;
  /** 注入的 `spawnNek`；缺省抛 `nek_unavailable`（测试里不希望意外拉起进程）。 */
  spawn?: (args: readonly string[]) => Promise<NekRpcProcessHandle>;
}

export interface MemoryNekConfigHostExecutor extends NekConfigHostExecutor {
  files: Map<string, string>;
  /** 每次写入（含 `.tmp` 与 rename）按顺序记录，便于断言原子写。 */
  writes: string[];
  setFile: (path: string, content: string) => void;
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/u, "");
}

/**
 * 内存执行器：测试与"没有真实 nek 的环境"用。
 *
 * 语义与 Node fs 对齐（缺失文件返回 null、`.tmp` + rename、锁回调同步），
 * mtime 由单调计数器模拟，保证每次写入后 revision 都会变化。
 */
export function createMemoryNekConfigHostExecutor(
  options: MemoryNekConfigHostExecutorOptions = {},
): MemoryNekConfigHostExecutor {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const mtimes = new Map<string, number>();
  const writes: string[] = [];
  let clock = 1_000;

  const tick = (path: string): void => {
    clock += 1;
    mtimes.set(path, clock);
  };
  const setFile = (path: string, content: string): void => {
    files.set(path, content);
    tick(path);
  };
  for (const path of files.keys()) {
    mtimes.set(path, clock);
  }

  const executor: MemoryNekConfigHostExecutor = {
    id: options.id ?? "local",
    files,
    writes,
    setFile,
    homeDir: () => options.home ?? "/home/nek",
    agentDir: () => options.agentDir ?? join(options.home ?? "/home/nek", ".nek", "agent"),
    readFile: async (path) => files.get(path) ?? null,
    writeFileAtomic: async (path, content) => {
      const tmpPath = `${path}.tmp`;
      setFile(tmpPath, content);
      writes.push(`write:${tmpPath}`);
      files.delete(tmpPath);
      mtimes.delete(tmpPath);
      setFile(path, content);
      writes.push(`rename:${tmpPath}->${path}`);
    },
    stat: async (path) => {
      if (files.has(path)) {
        return { mtimeMs: mtimes.get(path) ?? 0, size: Buffer.byteLength(files.get(path) ?? ""), isDirectory: false };
      }
      const prefix = `${normalizePath(path)}/`;
      const hasChildren = [...files.keys()].some((key) => normalizePath(key).startsWith(prefix));
      return hasChildren ? { mtimeMs: 0, size: 0, isDirectory: true } : null;
    },
    listDir: async (path) => {
      const prefix = `${normalizePath(path)}/`;
      const children = new Map<string, boolean>();
      for (const key of files.keys()) {
        const normalized = normalizePath(key);
        if (!normalized.startsWith(prefix)) continue;
        const rest = normalized.slice(prefix.length);
        const separator = rest.indexOf("/");
        const name = separator === -1 ? rest : rest.slice(0, separator);
        children.set(name, separator !== -1 || children.get(name) === true);
      }
      return [...children].map(([name, isDirectory]) => ({ name, isDirectory }));
    },
    remove: async (path) => {
      files.delete(path);
      mtimes.delete(path);
      writes.push(`remove:${path}`);
    },
    rename: async (from, to) => {
      const content = files.get(from);
      if (content === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      mtimes.delete(from);
      setFile(to, content);
      writes.push(`rename:${from}->${to}`);
    },
    spawnNek: async (args) => {
      if (!options.spawn) {
        throw new Error(`no nek process available in the memory executor (args: ${args.join(" ")})`);
      }
      return await options.spawn(args);
    },
    lock: {
      runLocked: (path, critical) => {
        // 单线程 + 同步回调：与 proper-lockfile 的同步临界区同语义。
        const next = critical(files.get(path));
        if (next !== undefined) setFile(path, next);
      },
    },
  };
  return executor;
}
