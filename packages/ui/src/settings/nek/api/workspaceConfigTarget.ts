import {
  NEK_WORKSPACE_CONFIG_METHODS,
  type INekWorkspaceConfigService,
  type NekWorkspaceConfigMethod,
} from "@zcode/services";
import type { INekConfigApi, NekConfigTarget } from "@zcode/shared/nek-protocol";
import { sameTarget } from "./NekSettingsContext.js";

/** 活动工作区的配置走它现有的连接，不另开 SSH，也不把其 cwd 交给主进程的本机执行器。 */
export function withWorkspaceConfigTarget(
  config: INekConfigApi,
  service: INekWorkspaceConfigService,
  workspaceTarget: NekConfigTarget,
): INekConfigApi {
  const methods: ReadonlySet<PropertyKey> = new Set(NEK_WORKSPACE_CONFIG_METHODS);
  return new Proxy(config, {
    get(api, name, receiver) {
      const fallback = () => Reflect.get(api, name, receiver);
      if (name === "watch") {
        return ((target, listener, cwd) => {
          if (!sameTarget(target, workspaceTarget)) return api.watch(target, listener, cwd);
          const lease = service.onDynamicConfigChange(cwd)(listener);
          return () => lease.dispose();
        }) satisfies INekConfigApi["watch"];
      }
      if (name === "onReloadResult") {
        return ((target, listener) => {
          if (!sameTarget(target, workspaceTarget)) return api.onReloadResult(target, listener);
          const lease = service.onDynamicDidReload()(listener);
          return () => lease.dispose();
        }) satisfies INekConfigApi["onReloadResult"];
      }
      if (!methods.has(name)) return fallback();
      return (target: NekConfigTarget, ...args: unknown[]) => {
        if (sameTarget(target, workspaceTarget)) {
          return Reflect.apply(service.callConfig, service, [
            name as NekWorkspaceConfigMethod,
            ...args,
          ]);
        }
        return Reflect.apply(fallback() as (...args: unknown[]) => unknown, api, [target, ...args]);
      };
    },
  });
}
