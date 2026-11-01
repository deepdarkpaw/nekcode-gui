import { describe, expect, it } from "vitest";
import type { RemoteDesktopMessage } from "@zcode/shared";
import { createHostCredentialBridge } from "./hostCredentialBridge.js";

type CredentialRequest = Extract<RemoteDesktopMessage, { type: "remote-credential-request" }>;
type Reply = (request: CredentialRequest) => RemoteDesktopMessage | undefined;

/** 模拟 utilityProcess parentPort：请求同步交给 reply，回包异步投递给 host 监听器。 */
function fakeParentPort(reply: Reply) {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const requests: CredentialRequest[] = [];
  const deliver = (data: unknown) => {
    queueMicrotask(() => {
      for (const listener of listeners) listener({ data });
    });
  };
  return {
    requests,
    deliver,
    on: (_event: "message", listener: (event: { data: unknown }) => void) =>
      listeners.add(listener),
    postMessage: (message: unknown) => {
      const credentialRequest = message as CredentialRequest;
      requests.push(credentialRequest);
      const response = reply(credentialRequest);
      if (response) deliver(response);
    },
  };
}

function inMemoryMain(): Reply {
  const entries = new Map<string, string>();
  return (request) => {
    if (request.operation === "save") entries.set(request.key, request.value ?? "");
    if (request.operation === "delete") entries.delete(request.key);
    return {
      type: "remote-credential-result",
      requestId: request.requestId,
      ...(request.operation === "load" ? { value: entries.get(request.key) ?? null } : {}),
    };
  };
}

describe("createHostCredentialBridge", () => {
  it("sends every workspace credential operation to main instead of host disk", async () => {
    const port = fakeParentPort(inMemoryMain());
    const credentials = createHostCredentialBridge(port);
    await credentials.save("remote-workspace:abc", "s3cret");
    expect(await credentials.load("remote-workspace:abc")).toBe("s3cret");
    await credentials.delete("remote-workspace:abc");
    expect(await credentials.load("remote-workspace:abc")).toBeNull();
    expect(port.requests.map((request) => request.operation)).toEqual([
      "save",
      "load",
      "delete",
      "load",
    ]);
  });

  it("surfaces main's error instead of pretending the credential persisted", async () => {
    const port = fakeParentPort((request) => ({
      type: "remote-credential-result",
      requestId: request.requestId,
      error: "OS credential encryption is unavailable",
    }));
    const credentials = createHostCredentialBridge(port);
    await expect(credentials.save("remote-workspace:abc", "s3cret")).rejects.toThrow(
      /encryption is unavailable/,
    );
  });

  it("ignores replies for unknown requests and unrelated messages", async () => {
    const port = fakeParentPort(() => undefined);
    const credentials = createHostCredentialBridge(port);
    const loading = credentials.load("remote-workspace:abc");
    port.deliver({ type: "remote-credential-result", requestId: "someone-else", value: "x" });
    port.deliver({ type: "unrelated" });
    const [request] = port.requests;
    port.deliver({
      type: "remote-credential-result",
      requestId: request?.requestId,
      value: "mine",
    });
    expect(await loading).toBe("mine");
  });
});
