import { randomUUID } from "node:crypto";
import { remoteDesktopMessageSchema, type RemoteDesktopMessage } from "@zcode/shared";
import type { ICredentialService } from "@zcode/services";

/** Workspace history credentials always cross to main's OS-encrypted store, never host disk. */
export function createHostCredentialBridge(port: {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): unknown;
}): ICredentialService {
  const pending = new Map<string, {
    resolve(value: string | null): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  port.on("message", ({ data }) => {
    const parsed = remoteDesktopMessageSchema.safeParse(data);
    if (!parsed.success || parsed.data.type !== "remote-credential-result") return;
    const request = pending.get(parsed.data.requestId);
    if (!request) return;
    pending.delete(parsed.data.requestId);
    clearTimeout(request.timer);
    if (parsed.data.error) request.reject(new Error(parsed.data.error));
    else request.resolve(parsed.data.value ?? null);
  });
  const call = (operation: "load" | "save" | "delete", key: string, value?: string) => {
    if (pending.size >= 64) return Promise.reject(new Error("too many pending credential requests"));
    const requestId = randomUUID();
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("main credential store request timed out"));
      }, 30_000);
      pending.set(requestId, { resolve, reject, timer });
      const message: RemoteDesktopMessage = {
        type: "remote-credential-request", requestId, operation, key, ...(value === undefined ? {} : { value }),
      };
      try { port.postMessage(message); }
      catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  };
  return {
    load: (key) => call("load", key),
    save: async (key, value) => { await call("save", key, value); },
    delete: async (key) => { await call("delete", key); },
  };
}
