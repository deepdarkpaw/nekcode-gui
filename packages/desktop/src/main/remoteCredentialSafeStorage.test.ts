import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRemoteCredentialSafeStorage,
  type SafeStorageLike,
} from "./remoteCredentialSafeStorage.js";

const temporaryDirectories: string[] = [];

async function createDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), "nek-remote-credentials-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value) => {
      const raw = value.toString("utf8");
      if (!raw.startsWith("encrypted:")) throw new Error("invalid ciphertext");
      return raw.slice("encrypted:".length);
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("RemoteCredentialSafeStorage", () => {
  it("加密落盘并能读取解密后的凭据", async () => {
    const directory = await createDirectory();
    const store = createRemoteCredentialSafeStorage({
      directory,
      safeStorage: fakeSafeStorage(),
    });

    await expect(
      store.setCredential("host-a", { username: "alice", password: "secret" }),
    ).resolves.toEqual({
      persisted: true,
    });
    const raw = await fs.readFile(store.filePath, "utf8");
    expect(raw).not.toContain("secret");
    expect(raw).toContain("entries");
    expect(await store.getCredential("host-a")).toEqual({ username: "alice", password: "secret" });
    await expect(fs.access(`${store.filePath}.tmp`)).rejects.toThrow();
  });

  it("删除凭据后不再返回，并移除空的加密文件", async () => {
    const directory = await createDirectory();
    const store = createRemoteCredentialSafeStorage({ directory, safeStorage: fakeSafeStorage() });
    await store.setCredential("host-a", "secret");

    await expect(store.deleteCredential("host-a")).resolves.toEqual({ persisted: true });
    await expect(store.getCredential("host-a")).resolves.toBeUndefined();
    await expect(fs.access(store.filePath)).rejects.toThrow();
  });

  it("钥匙串不可用时只保存在当前进程内存，不创建明文文件", async () => {
    const directory = await createDirectory();
    const store = createRemoteCredentialSafeStorage({
      directory,
      safeStorage: fakeSafeStorage(false),
    });

    await expect(store.setCredential("host-a", "secret")).resolves.toEqual({
      persisted: false,
      reason: "encryption_unavailable",
    });
    expect(await store.getCredential("host-a")).toBe("secret");
    await expect(fs.access(store.filePath)).rejects.toThrow();
    await expect(fs.access(directory)).resolves.toBeUndefined();
  });

  it("损坏的凭据文件会显式报错", async () => {
    const directory = await createDirectory();
    const store = createRemoteCredentialSafeStorage({ directory, safeStorage: fakeSafeStorage() });
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(store.filePath, "not-json", "utf8");

    await expect(store.getCredential("host-a")).rejects.toThrow("无法解析远程凭据文件");
  });
});
