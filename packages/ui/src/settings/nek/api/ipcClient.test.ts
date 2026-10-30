import { NEK_IPC_SUBSCRIPTION_LISTENER_INDEX } from "@zcode/shared";
import type {
  INekConfigApi,
  INekSettingsHostApi,
  IRemoteInteractionHostApi,
} from "@zcode/shared/nek-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopNekSettingsApis } from "./ipcClient.js";

/** 编译期核对：表中每个方法在契约里都存在，且该位置的参数是函数。不匹配时类型为 never。 */
type ListenerSlotsMatch<Api, Table extends Readonly<Record<string, number>>> = [
  {
    [Method in keyof Table]: Method extends keyof Api
      ? Api[Method] extends (...args: infer Params) => unknown
        ? Params[Table[Method]] extends (...args: never[]) => unknown
          ? true
          : false
        : false
      : false;
  }[keyof Table],
] extends [true]
  ? true
  : never;

type Request = {
  requestId: string;
  operation: string;
  method: string;
  args: unknown[];
  event?: "log";
};

type Bridge = {
  configInvoke: (request: Request) => Promise<unknown>;
  onConfigEvent: (listener: (payload: unknown) => void) => () => void;
  settingsHostInvoke: (request: Request) => Promise<unknown>;
  onSettingsHostEvent: (listener: (payload: unknown) => void) => () => void;
  remoteInteractionInvoke: (request: Request) => Promise<unknown>;
  onRemoteInteractionEvent: (listener: (payload: unknown) => void) => () => void;
};

const globalWithBridge = globalThis as typeof globalThis & { zcode?: { nekIpc?: Bridge } };

afterEach(() => {
  delete globalWithBridge.zcode;
});

describe("desktop nek IPC client", () => {
  it("forwards typed config calls and restores NekConfigApiError", async () => {
    const requests: Request[] = [];
    const bridge = createBridge((request) => {
      requests.push(request);
      if (request.method === "listTargets") {
        return Promise.resolve({ ok: true, value: [{ target: { kind: "local" } }] });
      }
      return Promise.resolve({
        ok: false,
        error: { code: "conflict", message: "changed externally" },
      });
    });
    globalWithBridge.zcode = { nekIpc: bridge };
    const apis = createDesktopNekSettingsApis();
    expect(apis?.isMock).toBe(false);
    await expect(apis!.config.listTargets()).resolves.toEqual([{ target: { kind: "local" } }]);
    await expect(apis!.config.readModelsConfig({ kind: "local" })).rejects.toMatchObject({
      name: "NekConfigApiError",
      code: "conflict",
    });
    expect(requests.map((request) => request.method)).toEqual(["listTargets", "readModelsConfig"]);
    expect(requests[0]?.operation).toBe("invoke");
  });

  it("subscribes, forwards events, and cancels the host subscription", async () => {
    const requests: Request[] = [];
    const eventListeners = new Set<(payload: unknown) => void>();
    const bridge = createBridge((request) => {
      requests.push(request);
      if (request.operation === "subscribe")
        return Promise.resolve({ ok: true, value: "subscription-1" });
      return Promise.resolve({ ok: true, value: undefined });
    }, eventListeners);
    globalWithBridge.zcode = { nekIpc: bridge };
    const apis = createDesktopNekSettingsApis()!;
    const changes: unknown[] = [];
    const dispose = apis.config.watch({ kind: "local" }, (change) => changes.push(change));
    for (const listener of eventListeners) {
      listener({
        requestId: requests[0]!.requestId,
        event: "subscription",
        payload: { file: "x" },
      });
    }
    await Promise.resolve();
    expect(changes).toEqual([{ file: "x" }]);
    dispose();
    await Promise.resolve();
    expect(requests.at(-1)).toMatchObject({ operation: "unsubscribe", args: ["subscription-1"] });
  });

  it("takes the listener from its contract position when trailing args follow it", async () => {
    const requests: Request[] = [];
    const eventListeners = new Set<(payload: unknown) => void>();
    const bridge = createBridge((request) => {
      requests.push(request);
      return Promise.resolve({ ok: true, value: "subscription-1" });
    }, eventListeners);
    globalWithBridge.zcode = { nekIpc: bridge };
    const apis = createDesktopNekSettingsApis()!;
    const changes: unknown[] = [];
    apis.config.watch({ kind: "local" }, (change) => changes.push(change), "/repo");
    for (const listener of eventListeners) {
      listener({
        requestId: requests[0]!.requestId,
        event: "subscription",
        payload: { file: "y" },
      });
    }
    await Promise.resolve();
    expect(requests[0]).toMatchObject({
      operation: "subscribe",
      method: "watch",
      args: [{ kind: "local" }, "/repo"],
    });
    expect(changes).toEqual([{ file: "y" }]);
  });

  it("keeps the listener table aligned with the contract signatures", () => {
    const config: ListenerSlotsMatch<
      INekConfigApi,
      typeof NEK_IPC_SUBSCRIPTION_LISTENER_INDEX.config
    > = true;
    const host: ListenerSlotsMatch<
      INekSettingsHostApi,
      (typeof NEK_IPC_SUBSCRIPTION_LISTENER_INDEX)["settings-host"]
    > = true;
    const remote: ListenerSlotsMatch<
      IRemoteInteractionHostApi,
      (typeof NEK_IPC_SUBSCRIPTION_LISTENER_INDEX)["remote-interaction"]
    > = true;
    expect([config, host, remote]).toEqual([true, true, true]);
  });

  it("streams install logs on the request and removes the callback from args", async () => {
    const requests: Request[] = [];
    const eventListeners = new Set<(payload: unknown) => void>();
    const bridge = createBridge(
      (request) => {
        requests.push(request);
        if (request.event === "log") {
          for (const listener of eventListeners) {
            listener({ requestId: request.requestId, event: "log", payload: "installing" });
          }
        }
        return Promise.resolve({ ok: true, value: { ok: true, version: "1" } });
      },
      eventListeners,
      "settings",
    );
    globalWithBridge.zcode = { nekIpc: bridge };
    const apis = createDesktopNekSettingsApis()!;
    const logs: string[] = [];
    await apis.host.installLocalNek({}, (line) => logs.push(line));
    const request = requests[0]!;
    expect(request.event).toBe("log");
    expect(request.args).toEqual([{}]);
    expect(logs).toEqual(["installing"]);
  });
});

function createBridge(
  invoke: (request: Request) => Promise<unknown>,
  eventListeners = new Set<(payload: unknown) => void>(),
  scope: "config" | "settings" = "config",
): Bridge {
  const configInvoke =
    scope === "config" ? invoke : () => Promise.resolve({ ok: true, value: undefined });
  const settingsHostInvoke =
    scope === "settings" ? invoke : () => Promise.resolve({ ok: true, value: undefined });
  return {
    configInvoke,
    onConfigEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    settingsHostInvoke,
    onSettingsHostEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    remoteInteractionInvoke: () => Promise.resolve({ ok: true, value: undefined }),
    onRemoteInteractionEvent: () => () => undefined,
  };
}
