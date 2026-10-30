let nextRequestId = 0;

function randomRequestId(): string {
  nextRequestId += 1;
  return `nek-ipc:${Date.now()}:${nextRequestId}`;
}
import type {
  INekConfigApi,
  INekSettingsHostApi,
  IRemoteInteractionHostApi,
} from "@zcode/shared/nek-protocol";
import {
  nekIpcSubscriptionListenerIndex,
  type NekIpcEvent,
  type NekIpcRequest,
  type NekIpcScope,
} from "@zcode/shared";
import type { NekSettingsApis } from "./NekSettingsContext.js";
import { toNekConfigApiError } from "./nekErrors.js";

interface IpcResponse {
  ok: boolean;
  value?: unknown;
  error?: unknown;
}

interface NekIpcBridge {
  configInvoke(request: NekIpcRequest): Promise<unknown>;
  onConfigEvent(listener: (payload: unknown) => void): () => void;
  settingsHostInvoke(request: NekIpcRequest): Promise<unknown>;
  onSettingsHostEvent(listener: (payload: unknown) => void): () => void;
  remoteInteractionInvoke(request: NekIpcRequest): Promise<unknown>;
  onRemoteInteractionEvent(listener: (payload: unknown) => void): () => void;
}

type Scope = NekIpcScope;

const LOG_METHODS = new Set(["installLocalNek", "installNek", "runNekUpdate"]);

function readBridge(): NekIpcBridge | null {
  const root = globalThis as typeof globalThis & {
    zcode?: { nekIpc?: NekIpcBridge };
  };
  return root.zcode?.nekIpc ?? null;
}

function readResponse(raw: unknown): IpcResponse {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as { ok?: unknown }).ok !== "boolean"
  ) {
    throw new Error("invalid nek IPC response");
  }
  return raw as IpcResponse;
}

function readEvent(raw: unknown): NekIpcEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const event = raw as Partial<NekIpcEvent>;
  return typeof event.requestId === "string" && typeof event.event === "string"
    ? (event as NekIpcEvent)
    : null;
}

function methodName(property: PropertyKey): string {
  if (typeof property !== "string" || !/^[A-Za-z][A-Za-z0-9]*$/u.test(property)) {
    throw new Error(`invalid nek IPC method: ${String(property)}`);
  }
  return property;
}

class NekIpcClient {
  constructor(private readonly bridge: NekIpcBridge) {}

  async invoke(
    scope: Scope,
    method: string,
    args: unknown[],
    event?: "log",
    streamListener?: (payload: unknown) => void,
  ): Promise<unknown> {
    const request: NekIpcRequest = {
      requestId: randomRequestId(),
      operation: "invoke",
      method,
      args,
      ...(event ? { event } : {}),
    };
    const removeEventListener = streamListener
      ? this.onEvent(scope, request.requestId, streamListener)
      : undefined;
    try {
      const result = readResponse(await this.invokeRaw(scope, request));
      if (!result.ok) throw toNekConfigApiError(result.error);
      return result.value;
    } finally {
      removeEventListener?.();
    }
  }

  subscribe(
    scope: Scope,
    method: string,
    args: unknown[],
    listener: (value: unknown) => void,
  ): () => void {
    const request: NekIpcRequest = {
      requestId: randomRequestId(),
      operation: "subscribe",
      method,
      args,
    };
    const removeEventListener = this.onEvent(scope, request.requestId, listener);
    let subscriptionId: string | undefined;
    void this.invokeRaw(scope, request)
      .then((raw) => {
        const result = readResponse(raw);
        if (!result.ok) throw toNekConfigApiError(result.error);
        if (typeof result.value !== "string") throw new Error("invalid nek IPC subscription id");
        subscriptionId = result.value;
      })
      .catch((error: unknown) => {
        removeEventListener();
        console.error("nek IPC subscription failed", error);
      });
    return () => {
      removeEventListener();
      if (!subscriptionId) return;
      const unsubscribe: NekIpcRequest = {
        requestId: randomRequestId(),
        operation: "unsubscribe",
        method: "unsubscribe",
        args: [subscriptionId],
      };
      void this.invokeRaw(scope, unsubscribe).catch((error: unknown) => {
        console.error("nek IPC unsubscribe failed", error);
      });
    };
  }

  createApi<T extends object>(scope: Scope): T {
    return new Proxy(
      {},
      {
        get: (_target, property) => {
          const method = methodName(property);
          return (...rawArgs: unknown[]) => {
            const listenerIndex = nekIpcSubscriptionListenerIndex(scope, method);
            if (listenerIndex !== undefined) {
              const listener = rawArgs[listenerIndex];
              if (typeof listener !== "function") throw new Error(`${method} listener is required`);
              const args = rawArgs.filter((_value, index) => index !== listenerIndex);
              return this.subscribe(scope, method, args, listener as (value: unknown) => void);
            }
            const withLog = LOG_METHODS.has(method) && typeof rawArgs.at(-1) === "function";
            const streamListener = withLog ? rawArgs.pop() : undefined;
            return this.invoke(
              scope,
              method,
              rawArgs,
              withLog ? "log" : undefined,
              withLog ? (streamListener as (payload: unknown) => void) : undefined,
            );
          };
        },
      },
    ) as T;
  }

  private invokeRaw(scope: Scope, request: NekIpcRequest): Promise<unknown> {
    switch (scope) {
      case "config":
        return this.bridge.configInvoke(request);
      case "settings-host":
        return this.bridge.settingsHostInvoke(request);
      case "remote-interaction":
        return this.bridge.remoteInteractionInvoke(request);
    }
  }

  private onEvent(scope: Scope, requestId: string, listener: (value: unknown) => void): () => void {
    const callback = (raw: unknown) => {
      const event = readEvent(raw);
      if (event?.requestId === requestId) listener(event.payload);
    };
    switch (scope) {
      case "config":
        return this.bridge.onConfigEvent(callback);
      case "settings-host":
        return this.bridge.onSettingsHostEvent(callback);
      case "remote-interaction":
        return this.bridge.onRemoteInteractionEvent(callback);
    }
  }
}

export function createDesktopNekSettingsApis(): NekSettingsApis | null {
  const bridge = readBridge();
  if (!bridge) return null;
  const client = new NekIpcClient(bridge);
  return {
    config: client.createApi<INekConfigApi>("config"),
    host: client.createApi<INekSettingsHostApi>("settings-host"),
    isMock: false,
  };
}

export function createDesktopRemoteInteractionApi(): IRemoteInteractionHostApi | null {
  const bridge = readBridge();
  if (!bridge) return null;
  const client = new NekIpcClient(bridge);
  return client.createApi<IRemoteInteractionHostApi>("remote-interaction");
}
