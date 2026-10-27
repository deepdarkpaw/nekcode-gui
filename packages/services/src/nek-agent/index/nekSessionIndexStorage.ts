import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NekSessionIndexDocument, NekSessionIndexEntry, NekSessionIndexStorage } from "./types.js";

const EMPTY_DOCUMENT: NekSessionIndexDocument = { version: 1, entries: [] };

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

export function normalizeNekSessionIndex(
  value: unknown,
  maxEntries = 5_000,
): NekSessionIndexDocument {
  if (typeof value !== "object" || value === null) return { ...EMPTY_DOCUMENT, entries: [] };
  const raw = value as { version?: unknown; entries?: unknown };
  if (raw.version !== 1 || !Array.isArray(raw.entries)) return { ...EMPTY_DOCUMENT, entries: [] };
  const entries = raw.entries.filter(isEntry).slice(0, Math.max(1, maxEntries));
  return { version: 1, entries };
}

export class MemoryNekSessionIndexStorage implements NekSessionIndexStorage {
  private document: NekSessionIndexDocument;

  constructor(initial: NekSessionIndexDocument = EMPTY_DOCUMENT, private readonly maxEntries = 5_000) {
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
  /** Injected for tests; defaults to crypto-independent monotonic suffix. */
  tempPath?: string;
}

export class JsonNekSessionIndexStorage implements NekSessionIndexStorage {
  private readonly maxEntries: number;
  private readonly tempPath: string;

  constructor(
    private readonly path: string,
    options: JsonNekSessionIndexStorageOptions = {},
  ) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 5_000);
    this.tempPath = options.tempPath ?? `${path}.tmp`;
  }

  async load(): Promise<NekSessionIndexDocument> {
    try {
      const text = await readFile(this.path, "utf8");
      return normalizeNekSessionIndex(JSON.parse(text), this.maxEntries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_DOCUMENT, entries: [] };
      throw error;
    }
  }

  async save(document: NekSessionIndexDocument): Promise<void> {
    const normalized = normalizeNekSessionIndex(document, this.maxEntries);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await rename(this.tempPath, this.path);
  }
}
