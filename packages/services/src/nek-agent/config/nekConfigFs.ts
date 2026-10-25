import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { readdir, readFile, rename, stat, unlink, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";

/**
 * 配置文件访问层：注入式 fs + 锁 + 乐观并发 revision。
 *
 * 目标机器可能就是本机（host 直接读写 `~/.nek/agent`），也可能是远端（gui-server 在本机读写自己的
 * `~/.nek/agent`）；两者用同一套接口，所以这一层不假设任何路径来源。
 */

/** 文件内容 + 元信息；`null` 表示文件不存在。 */
export interface NekFileSnapshot {
  content: string;
  mtimeMs: number;
  size: number;
}

export interface NekConfigFs {
  /** 同步读改写用的锁：与 nek 的 `SettingsManager` 同一把 `proper-lockfile` 锁。 */
  readonly lock: NekConfigLock;
  stat: (path: string) => Promise<{ mtimeMs: number; size: number } | null>;
  readFile: (path: string) => Promise<string | null>;
  writeFile: (path: string, content: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  mkdirp: (path: string) => Promise<void>;
  listDir: (path: string) => Promise<string[]>;
}

/**
 * 与 nek 相同的锁协议：`proper-lockfile` 默认在 `<file>.lock` 上建目录。
 * 回调必须同步执行（nek 的 `withLock` 就是同步临界区）。
 */
export interface NekConfigLock {
  /** 返回值仅用于测试观测（是否写入）；生产代码忽略它。 */
  run: (path: string, critical: (current: string | undefined) => string | undefined) => void;
}

/** 乐观并发令牌：mtime + size + 内容哈希（mtime 精度不足时由哈希兜底）。 */
export interface NekConfigRevision {
  mtimeMs: number;
  size: number;
  /** sha256(content)。 */
  hash: string;
}

export class NekConfigConflictError extends Error {
  constructor(
    readonly path: string,
    readonly expected: NekConfigRevision | null,
    readonly actual: NekConfigRevision | null,
  ) {
    super(`${path} was modified externally; reload before writing`);
    this.name = "NekConfigConflictError";
  }
}

export class NekConfigParseError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "NekConfigParseError";
  }
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function revisionOf(snapshot: {
  content: string;
  mtimeMs: number;
  size: number;
}): NekConfigRevision {
  return { mtimeMs: snapshot.mtimeMs, size: snapshot.size, hash: hashContent(snapshot.content) };
}

export function sameRevision(
  left: NekConfigRevision | null,
  right: NekConfigRevision | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.hash === right.hash && left.size === right.size;
}

/** 读文件快照；不存在返回 null（不把"缺失"当错误）。 */
export async function readSnapshot(fs: NekConfigFs, path: string): Promise<NekFileSnapshot | null> {
  const info = await fs.stat(path);
  if (!info) return null;
  const content = await fs.readFile(path);
  if (content === null) return null;
  return { content, mtimeMs: info.mtimeMs, size: info.size };
}

/**
 * 原子写：先写 `<path>.tmp`，再 rename 覆盖。
 *
 * 为什么用 `.tmp` + rename 而不是直接写：nek 随时可能在读同一个文件，半写状态会被它当成
 * 损坏的配置；rename 在同一文件系统内是原子的。
 */
export async function atomicWrite(fs: NekConfigFs, path: string, content: string): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await fs.mkdirp(dirname(path));
  try {
    await fs.writeFile(tmpPath, content);
    await fs.rename(tmpPath, path);
  } catch (error) {
    await fs.remove(tmpPath).catch(() => undefined);
    throw error;
  }
}

/** 需要 revision 校验时先比对当前文件，再返回是否允许写入。 */
export async function assertRevision(
  fs: NekConfigFs,
  path: string,
  expected: NekConfigRevision | null | undefined,
): Promise<NekFileSnapshot | null> {
  const snapshot = await readSnapshot(fs, path);
  if (expected === undefined) return snapshot;
  const actual = snapshot === null ? null : revisionOf(snapshot);
  if (!sameRevision(actual, expected)) throw new NekConfigConflictError(path, expected, actual);
  return snapshot;
}

/** 本机 fs 实现。 */
export function createNodeNekConfigFs(): NekConfigFs {
  const lock: NekConfigLock = {
    run: (path, critical) => {
      const exists = existsSync(path);
      const release = exists ? acquireLockSyncWithRetry(path) : undefined;
      let wrote: string | undefined;
      try {
        const current = exists ? readFileSync(path, "utf-8") : undefined;
        const next = critical(current);
        if (next !== undefined) {
          if (!release) {
            // 文件还不存在：先拿到锁再创建（与 nek 的顺序一致）。
            const late = acquireLockSyncWithRetry(path);
            try {
              mkdirSync(dirname(path), { recursive: true });
              writeFileSync(path, next, "utf-8");
            } finally {
              late();
            }
          } else {
            writeFileSync(path, next, "utf-8");
          }
          wrote = next;
        }
        void wrote;
      } finally {
        release?.();
      }
    },
  };
  return {
    lock,
    stat: async (path) => {
      try {
        const info = await stat(path);
        if (!info.isFile()) return null;
        return { mtimeMs: info.mtimeMs, size: info.size };
      } catch {
        return null;
      }
    },
    readFile: async (path) => {
      try {
        return await readFile(path, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    writeFile: async (path, content) => {
      await writeFile(path, content, "utf-8");
    },
    rename: async (from, to) => {
      await rename(from, to);
    },
    remove: async (path) => {
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
    mkdirp: async (path) => {
      await mkdir(path, { recursive: true });
    },
    listDir: async (path) => {
      try {
        return await readdir(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
  };
}

/** 与 nek `FileSettingsStorage.acquireLockSyncWithRetry` 同参数、同退避。 */
function acquireLockSyncWithRetry(path: string): () => void {
  const maxAttempts = 10;
  const delayMs = 20;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return lockfile.lockSync(path, { realpath: false });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : undefined;
      if (code !== "ELOCKED" || attempt === maxAttempts) throw error;
      lastError = error;
      const start = Date.now();
      while (Date.now() - start < delayMs) {
        // 同步忙等：nek 的 SettingsManager 就是同步 API，不能在这里改成异步。
      }
    }
  }
  throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
}

/** 目录拼接辅助（Windows/posix 通用）。 */
export function nekConfigPath(dir: string, ...segments: string[]): string {
  return join(dir, ...segments);
}

/** 供测试使用：不落盘的 fs 替身用内存 Map。 */
export function createMemoryNekConfigFs(): NekConfigFs & {
  files: Map<string, string>;
  lockCallCount: number;
} {
  const files = new Map<string, string>();
  const fs: NekConfigFs & { files: Map<string, string>; lockCallCount: number } = {
    files,
    lockCallCount: 0,
    lock: {
      run: (path, critical) => {
        fs.lockCallCount += 1;
        const next = critical(files.get(path));
        if (next !== undefined) files.set(path, next);
        return undefined;
      },
    },
    stat: async (path) =>
      files.has(path) ? { mtimeMs: 1, size: Buffer.byteLength(files.get(path) ?? "") } : null,
    readFile: async (path) => files.get(path) ?? null,
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    rename: async (from, to) => {
      const content = files.get(from);
      if (content === undefined) throw new Error(`missing ${from}`);
      files.delete(from);
      files.set(to, content);
    },
    remove: async (path) => {
      files.delete(path);
    },
    mkdirp: async () => undefined,
    listDir: async (path) => {
      // 路径分隔符因平台而异：统一成正斜杠再比较，测试才能在任意平台上跑。
      const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/u, "");
      const prefix = `${normalize(path)}/`;
      return [...files.keys()]
        .filter((key) => normalize(key).startsWith(prefix))
        .map((key) => normalize(key).slice(prefix.length));
    },
  };
  return fs;
}

export { renameSync };
