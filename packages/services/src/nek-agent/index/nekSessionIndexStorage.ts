import { atomicWrite, createNodeNekConfigFs, type NekConfigFs } from "../config/nekConfigFs.js";
import type {
  NekSessionIndexDocument,
  NekSessionIndexEntry,
  NekSessionIndexStorage,
} from "./types.js";

const DEFAULT_MAX_ENTRIES = 5_000;

/** JSON 索引文件损坏：抛错而不是当作空索引，避免静默丢掉用户的置顶/未读状态。 */
export class NekSessionIndexCorruptError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`nek session index ${path} is corrupt: ${detail}`);
    this.name = "NekSessionIndexCorruptError";
  }
}

export function emptyNekSessionIndex(): NekSessionIndexDocument {
  return { version: 1, entries: [] };
}

function isEntry(value: unknown): value is NekSessionIndexEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<NekSessionIndexEntry>;
  return (
    typeof entry.sessionPath === "string" &&
    typeof entry.pinned === "boolean" &&
    typeof entry.archived === "boolean" &&
    typeof entry.unread === "boolean" &&
    (entry.group === undefined || typeof entry.group === "string") &&
    (entry.lastOpenedAt === undefined || typeof entry.lastOpenedAt === "string") &&
    (entry.invalid === undefined || typeof entry.invalid === "boolean")
  );
}

/** 已类型化的文档（内存存储、写盘前）：剔除不合法字段并截断到上限。 */
export function normalizeNekSessionIndex(
  value: unknown,
  maxEntries = DEFAULT_MAX_ENTRIES,
): NekSessionIndexDocument {
  if (typeof value !== "object" || value === null) return emptyNekSessionIndex();
  const raw = value as { version?: unknown; entries?: unknown };
  if (raw.version !== 1 || !Array.isArray(raw.entries)) return emptyNekSessionIndex();
  const entries = raw.entries.filter(isEntry).slice(0, Math.max(1, maxEntries));
  return { version: 1, entries };
}

/**
 * 严格解析索引文件：形状不对就是损坏，报出路径与位置。
 *
 * 与 `normalizeNekSessionIndex` 的区别：这里不丢弃坏条目——静默丢弃会让用户看到"置顶/未读突然消失"。
 */
export function parseNekSessionIndex(
  text: string,
  path: string,
  maxEntries = DEFAULT_MAX_ENTRIES,
): NekSessionIndexDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new NekSessionIndexCorruptError(path, `invalid JSON (${(error as Error).message})`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NekSessionIndexCorruptError(path, "document is not a JSON object");
  }
  const raw = parsed as { version?: unknown; entries?: unknown };
  if (raw.version !== 1)
    throw new NekSessionIndexCorruptError(path, `unsupported version ${String(raw.version)}`);
  if (!Array.isArray(raw.entries))
    throw new NekSessionIndexCorruptError(path, "entries is not an array");
  const entries = raw.entries.map((entry, index) => {
    if (!isEntry(entry))
      throw new NekSessionIndexCorruptError(path, `entries[${index}] is not a session entry`);
    return { ...entry };
  });
  return { version: 1, entries: entries.slice(0, Math.max(1, maxEntries)) };
}

export class MemoryNekSessionIndexStorage implements NekSessionIndexStorage {
  private document: NekSessionIndexDocument;

  constructor(
    initial: NekSessionIndexDocument = emptyNekSessionIndex(),
    private readonly maxEntries = DEFAULT_MAX_ENTRIES,
  ) {
    this.document = normalizeNekSessionIndex(initial, maxEntries);
  }

  async load(): Promise<NekSessionIndexDocument> {
    return {
      version: 1,
      entries: this.document.entries.map((entry) => ({ ...entry })),
    };
  }

  async save(document: NekSessionIndexDocument): Promise<void> {
    this.document = normalizeNekSessionIndex(document, this.maxEntries);
  }
}

export interface JsonNekSessionIndexStorageOptions {
  maxEntries?: number;
  /** 注入 fs：生产是本机 fs，测试用内存实现观察 `.tmp` + rename 的顺序。 */
  fs?: NekConfigFs;
}

/**
 * JSON 文件存储：`.tmp` + rename 原子写（`nekConfigFs.atomicWrite`），读到的文件损坏时抛
 * `NekSessionIndexCorruptError`。文件不存在不是损坏，返回空索引。
 */
export class JsonNekSessionIndexStorage implements NekSessionIndexStorage {
  private readonly maxEntries: number;
  private readonly fs: NekConfigFs;

  constructor(
    private readonly path: string,
    options: JsonNekSessionIndexStorageOptions = {},
  ) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.fs = options.fs ?? createNodeNekConfigFs();
  }

  async load(): Promise<NekSessionIndexDocument> {
    const text = await this.fs.readFile(this.path);
    if (text === null) return emptyNekSessionIndex();
    return parseNekSessionIndex(text, this.path, this.maxEntries);
  }

  async save(document: NekSessionIndexDocument): Promise<void> {
    const normalized = normalizeNekSessionIndex(document, this.maxEntries);
    await atomicWrite(this.fs, this.path, `${JSON.stringify(normalized, null, 2)}\n`);
  }
}
