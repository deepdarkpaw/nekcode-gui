import { safeStorage } from "electron";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const GUI_DIRECTORY = join(".nek", "gui");
export const REMOTE_CREDENTIAL_FILE_NAME = "credentials.enc.json";

export type RemoteCredentialValue = string | Record<string, string>;
export type RemoteCredentialStoreStatus =
  | { persisted: true }
  | { persisted: false; reason: "encryption_unavailable" };

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface CredentialFile {
  version: 1;
  entries: Record<string, string>;
}

interface FileSystemLike {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
}

export interface RemoteCredentialSafeStorageOptions {
  safeStorage?: SafeStorageLike;
  directory?: string;
  filePath?: string;
  fileSystem?: FileSystemLike;
}

const memoryByFile = new Map<string, Map<string, RemoteCredentialValue>>();

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function parseCredentialFile(raw: string): CredentialFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `无法解析远程凭据文件: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { entries?: unknown }).entries !== "object" ||
    (parsed as { entries?: unknown }).entries === null
  ) {
    throw new Error("远程凭据文件格式无效");
  }
  const entries = (parsed as { entries: Record<string, unknown> }).entries;
  if (Object.values(entries).some((value) => typeof value !== "string")) {
    throw new Error("远程凭据文件包含无效密文");
  }
  return { version: 1, entries: entries as Record<string, string> };
}

function parseCredentialValue(raw: string): RemoteCredentialValue {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `远程凭据明文解码失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  ) {
    return value as Record<string, string>;
  }
  throw new Error("远程凭据值格式无效");
}

function serializeCredentialValue(value: RemoteCredentialValue): string {
  return JSON.stringify(value);
}

export class RemoteCredentialSafeStorage {
  readonly filePath: string;
  private readonly safeStorage: SafeStorageLike;
  private readonly fileSystem: FileSystemLike;
  private readonly memory: Map<string, RemoteCredentialValue>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: RemoteCredentialSafeStorageOptions = {}) {
    this.filePath =
      options.filePath ??
      join(options.directory ?? join(homedir(), GUI_DIRECTORY), REMOTE_CREDENTIAL_FILE_NAME);
    this.safeStorage = options.safeStorage ?? safeStorage;
    this.fileSystem = options.fileSystem ?? (fs as unknown as FileSystemLike);
    let memory = memoryByFile.get(this.filePath);
    if (!memory) {
      memory = new Map();
      memoryByFile.set(this.filePath, memory);
    }
    this.memory = memory;
  }

  isEncryptionAvailable(): boolean {
    return this.safeStorage.isEncryptionAvailable();
  }

  async setCredential(
    key: string,
    value: RemoteCredentialValue,
  ): Promise<RemoteCredentialStoreStatus> {
    this.assertKey(key);
    if (!this.isEncryptionAvailable()) {
      this.memory.set(key, value);
      return { persisted: false, reason: "encryption_unavailable" };
    }
    return this.withWriteLock(async () => {
      const file = await this.readFile();
      const encrypted = this.safeStorage
        .encryptString(serializeCredentialValue(value))
        .toString("base64");
      file.entries[key] = encrypted;
      await this.writeFile(file);
      return { persisted: true };
    });
  }

  async getCredential(key: string): Promise<RemoteCredentialValue | undefined> {
    this.assertKey(key);
    if (!this.isEncryptionAvailable()) return this.memory.get(key);
    const file = await this.readFile();
    const encoded = file.entries[key];
    if (encoded === undefined) return undefined;
    let decrypted: string;
    try {
      decrypted = this.safeStorage.decryptString(Buffer.from(encoded, "base64"));
    } catch (error) {
      throw new Error(
        `远程凭据解密失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseCredentialValue(decrypted);
  }

  async deleteCredential(key: string): Promise<RemoteCredentialStoreStatus> {
    this.assertKey(key);
    if (!this.isEncryptionAvailable()) {
      this.memory.delete(key);
      return { persisted: false, reason: "encryption_unavailable" };
    }
    return this.withWriteLock(async () => {
      const file = await this.readFile();
      if (!(key in file.entries)) return { persisted: true };
      delete file.entries[key];
      if (Object.keys(file.entries).length === 0) {
        await this.fileSystem.rm(this.filePath, { force: true });
      } else {
        await this.writeFile(file);
      }
      return { persisted: true };
    });
  }

  async clear(): Promise<RemoteCredentialStoreStatus> {
    if (!this.isEncryptionAvailable()) {
      this.memory.clear();
      return { persisted: false, reason: "encryption_unavailable" };
    }
    return this.withWriteLock(async () => {
      await this.fileSystem.rm(this.filePath, { force: true });
      this.memory.clear();
      return { persisted: true };
    });
  }

  private assertKey(key: string): void {
    if (!key.trim()) throw new Error("远程凭据 key 不能为空");
  }

  private async readFile(): Promise<CredentialFile> {
    try {
      return parseCredentialFile(await this.fileSystem.readFile(this.filePath, "utf8"));
    } catch (error) {
      if (isMissingFile(error)) return { version: 1, entries: {} };
      throw error;
    }
  }

  private async writeFile(file: CredentialFile): Promise<void> {
    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.tmp`;
    await this.fileSystem.mkdir(directory, { recursive: true });
    await this.fileSystem.writeFile(this.filePath + ".tmp", JSON.stringify(file), "utf8");
    await this.fileSystem.rename(temporaryPath, this.filePath);
  }

  private withWriteLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function createRemoteCredentialSafeStorage(
  options: RemoteCredentialSafeStorageOptions = {},
): RemoteCredentialSafeStorage {
  return new RemoteCredentialSafeStorage(options);
}
