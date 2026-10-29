import { randomUUID } from "node:crypto";
import type { NekIpcEvent, NekIpcRequest } from "@zcode/shared";
import type { NekConfigHostBridge } from "./nekConfigHostBridge.js";
import type { NekRemoteInteractionHostService } from "./nekRemoteInteractionHostService.js";

export type NekIpcScope = "config" | "settings-host" | "remote-interaction";
type EventSink = (event: NekIpcEvent) => void;
type UnknownFunction = (...args: unknown[]) => unknown;

type Subscription = { scope: NekIpcScope; dispose: () => void };

function methodOf(target: object, method: string): UnknownFunction {
  const value: unknown = Reflect.get(target, method);
  if (typeof value !== "function") throw new Error(`unknown ${method} method: ${method}`);
  return value.bind(target) as UnknownFunction;
}

function subscriptionId(): string {
  return `nek-subscription:${randomUUID()}`;
}

/** Dispatches the three renderer IPC contracts while keeping listener ownership in the host. */
export class NekIpcHostRouter {
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(
    private readonly bridge: NekConfigHostBridge,
    private readonly remote: NekRemoteInteractionHostService,
  ) {}

  async dispatch(scope: NekIpcScope, request: NekIpcRequest, send: EventSink): Promise<unknown> {
    if (request.operation === "unsubscribe") {
      this.unsubscribe(request.args[0]);
      return;
    }
    if (request.operation === "subscribe") {
      return this.subscribe(scope, request, send);
    }
    const target = this.target(scope);
    const fn = methodOf(target, request.method);
    const args =
      request.event === "log"
        ? [...request.args, this.logSink(request.requestId, send)]
        : request.args;
    return await fn(...args);
  }

  dispose(): void {
    for (const subscription of this.subscriptions.values()) subscription.dispose();
    this.subscriptions.clear();
    this.bridge.dispose();
    this.remote.dispose();
  }

  private target(scope: NekIpcScope): object {
    switch (scope) {
      case "config":
        return this.bridge.configApi;
      case "settings-host":
        return this.bridge.hostApi;
      case "remote-interaction":
        return this.remote;
    }
  }

  private subscribe(scope: NekIpcScope, request: NekIpcRequest, send: EventSink): string {
    const target = this.target(scope);
    const listener = (payload: unknown) =>
      send({ requestId: request.requestId, event: "subscription", payload });
    const fn = methodOf(target, request.method);
    const result = fn(...request.args, listener);
    if (typeof result !== "function") {
      throw new Error(`${scope}.${request.method} did not return an unsubscribe function`);
    }
    const id = subscriptionId();
    this.subscriptions.set(id, { scope, dispose: result as () => void });
    return id;
  }

  private unsubscribe(rawId: unknown): void {
    if (typeof rawId !== "string") throw new Error("subscription id is required");
    const subscription = this.subscriptions.get(rawId);
    if (!subscription) return;
    this.subscriptions.delete(rawId);
    subscription.dispose();
  }

  private logSink(requestId: string, send: EventSink): (line: string) => void {
    return (line: string) => send({ requestId, event: "log", payload: line });
  }
}

export function createNekIpcHostRouter(
  bridge: NekConfigHostBridge,
  remote: NekRemoteInteractionHostService,
): NekIpcHostRouter {
  return new NekIpcHostRouter(bridge, remote);
}
