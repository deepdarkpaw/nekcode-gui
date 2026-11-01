import { ServiceCollection } from "./collection.js";
import { ITerminalService } from "./terminal/terminal.js";
import { IZCodeTaskService } from "./session/zcodeTaskService.js";
import { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import { IZCodeSessionService } from "./zcode-session/zcodeSession.js";
import { IFileWatcherService } from "./fileWatcher/fileWatcher.js";
import type { HostApiNetworkTransport } from "./providers/api/nodeApiNetwork.js";

interface ServiceWithDisposeAll {
  disposeAll: () => void;
}

interface ServiceWithDisposeAllAndWait {
  disposeAllAndWait: () => Promise<void>;
}

function hasDisposeAll(instance: unknown): instance is ServiceWithDisposeAll {
  return (
    typeof instance === "object" &&
    instance !== null &&
    "disposeAll" in instance &&
    typeof (instance as { disposeAll?: unknown }).disposeAll === "function"
  );
}

function hasDisposeAllAndWait(instance: unknown): instance is ServiceWithDisposeAllAndWait {
  return (
    typeof instance === "object" &&
    instance !== null &&
    typeof (instance as { disposeAllAndWait?: unknown }).disposeAllAndWait === "function"
  );
}

/** ServiceCollection owns model observation, configuration control processes and shared sqlite handles. */
const resources = new WeakMap<ServiceCollection, { dispose(): void }>();
const transports = new WeakMap<ServiceCollection, HostApiNetworkTransport>();

export function registerLocalServiceResources(
  services: ServiceCollection,
  resource: { dispose(): void },
): void {
  resources.set(services, resource);
}

export function registerHostApiNetworkTransportForDispose(
  services: ServiceCollection,
  transport: HostApiNetworkTransport,
): void {
  transports.set(services, transport);
}

function disposableServices(services: ServiceCollection) {
  return [
    services.getOptional(ITerminalService),
    services.getOptional(IZCodeTaskService),
    services.getOptional(IZCodeAgentService),
    services.getOptional(IZCodeSessionService),
    services.getOptional(IFileWatcherService),
  ].filter((service) => service !== undefined);
}

function disposeResources(services: ServiceCollection): void {
  resources.get(services)?.dispose();
  resources.delete(services);
}

export function disposeServiceResources(services: ServiceCollection): void {
  for (const service of disposableServices(services)) {
    if (hasDisposeAll(service)) service.disposeAll();
  }
  disposeResources(services);
  transports.get(services)?.dispose();
}

export async function disposeServiceResourcesAndWait(services: ServiceCollection): Promise<void> {
  for (const service of disposableServices(services)) {
    if (hasDisposeAllAndWait(service)) await service.disposeAllAndWait();
    else if (hasDisposeAll(service)) service.disposeAll();
  }
  disposeResources(services);
  await transports.get(services)?.disposeAndWait();
}
