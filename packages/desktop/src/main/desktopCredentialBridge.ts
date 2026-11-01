import {
  remoteDesktopMessageSchema,
  credentialKeySchema,
  credentialValueSchema,
  type RemoteDesktopMessage,
} from "@zcode/shared";
import { createRemoteCredentialSafeStorage } from "./remoteCredentialSafeStorage.js";

/** One store/write queue for settings hosts and every window's workspace credential RPC. */
export const desktopRemoteCredentialStore = createRemoteCredentialSafeStorage();

type CredentialRequest = Extract<RemoteDesktopMessage, { type: "remote-credential-request" }>;

export async function dispatchDesktopCredentialRequest(
  request: CredentialRequest,
  store = desktopRemoteCredentialStore,
): Promise<RemoteDesktopMessage> {
  try {
    const key = credentialKeySchema.parse(request.key);
    if (request.operation === "load") {
      const value = await store.getCredential(key);
      if (value !== undefined && typeof value !== "string") {
        throw new Error("workspace credential must be a string");
      }
      return { type: "remote-credential-result", requestId: request.requestId, value: value ?? null };
    }
    if (request.operation === "save") {
      const result = await store.setCredential(key, credentialValueSchema.parse(request.value));
      if (!result.persisted) throw new Error("OS credential encryption is unavailable; credential was not saved");
    } else {
      await store.deleteCredential(key);
    }
    return { type: "remote-credential-result", requestId: request.requestId };
  } catch (error) {
    return {
      type: "remote-credential-result",
      requestId: request.requestId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Registered before init-local so even a cold history reconnect can load credentials. */
export function attachDesktopCredentialBridge(child: {
  on(event: "message", listener: (message: unknown) => void): unknown;
  postMessage(message: unknown): void;
}): void {
  child.on("message", (message) => {
    const parsed = remoteDesktopMessageSchema.safeParse(message);
    if (!parsed.success || parsed.data.type !== "remote-credential-request") return;
    void dispatchDesktopCredentialRequest(parsed.data).then((result) => child.postMessage(result));
  });
}
