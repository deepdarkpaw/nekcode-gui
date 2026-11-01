import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

import { dispatchDesktopCredentialRequest } from "./desktopCredentialBridge.js";
import type { RemoteCredentialValue } from "./remoteCredentialSafeStorage.js";

function memoryStore(persisted = true) {
  const entries = new Map<string, RemoteCredentialValue>();
  const status = persisted
    ? ({ persisted: true } as const)
    : ({ persisted: false, reason: "encryption_unavailable" } as const);
  return {
    entries,
    getCredential: async (key: string) => entries.get(key),
    setCredential: async (key: string, value: RemoteCredentialValue) => {
      entries.set(key, value);
      return status;
    },
    deleteCredential: async (key: string) => {
      entries.delete(key);
      return status;
    },
  };
}

const request = (operation: "load" | "save" | "delete", value?: string) => ({
  type: "remote-credential-request" as const,
  requestId: `req-${operation}`,
  operation,
  key: "remote-workspace:abc",
  ...(value === undefined ? {} : { value }),
});

describe("dispatchDesktopCredentialRequest", () => {
  it("saves, loads and deletes workspace credentials in the main-process store", async () => {
    const store = memoryStore();
    expect(await dispatchDesktopCredentialRequest(request("save", "s3cret"), store)).toEqual({
      type: "remote-credential-result",
      requestId: "req-save",
    });
    expect(store.entries.get("remote-workspace:abc")).toBe("s3cret");
    expect(await dispatchDesktopCredentialRequest(request("load"), store)).toEqual({
      type: "remote-credential-result",
      requestId: "req-load",
      value: "s3cret",
    });
    await dispatchDesktopCredentialRequest(request("delete"), store);
    expect(await dispatchDesktopCredentialRequest(request("load"), store)).toMatchObject({
      value: null,
    });
  });

  it("answers with an error when OS encryption cannot persist the credential", async () => {
    const result = await dispatchDesktopCredentialRequest(
      request("save", "s3cret"),
      memoryStore(false),
    );
    expect(result).toMatchObject({
      requestId: "req-save",
      error: expect.stringMatching(/encryption is unavailable/),
    });
  });

  it("rejects non-string workspace credentials instead of leaking structured secrets", async () => {
    const store = memoryStore();
    store.entries.set("remote-workspace:abc", { password: "p" });
    const result = await dispatchDesktopCredentialRequest(request("load"), store);
    expect(result).toMatchObject({ error: "workspace credential must be a string" });
  });
});
