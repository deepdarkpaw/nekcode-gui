import type { INekConfigApi, NekConfigTarget } from "@zcode/shared/nek-protocol";
import { asNekConfigError } from "./errors.js";
import {
  NEK_WORKSPACE_CONFIG_METHODS,
  type INekWorkspaceConfigService,
} from "./workspaceConfigService.js";

const LOCAL: NekConfigTarget = { kind: "local" };

/** 复用承载会话的同一个 ConfigApi；远端 gui-server 上的 local 就是那台远端机器。 */
export function createWorkspaceConfigService(api: INekConfigApi): INekWorkspaceConfigService {
  const callConfig = async (name: string, ...args: unknown[]) => {
    if (!NEK_WORKSPACE_CONFIG_METHODS.some((method) => method === name)) {
      throw new Error(`Not a workspace configuration command: ${name}`);
    }
    try {
      return await Reflect.apply(Reflect.get(api, name), api, [LOCAL, ...args]);
    } catch (error) {
      // 远程 RPC 只透传 Error.message；带 code 的普通对象才能保留冲突语义。
      throw asNekConfigError(error).toJSON();
    }
  };
  return {
    callConfig: callConfig as INekWorkspaceConfigService["callConfig"],
    onDynamicConfigChange: (cwd) => (listener) => ({ dispose: api.watch(LOCAL, listener, cwd) }),
    onDynamicDidReload: () => (listener) => ({ dispose: api.onReloadResult(LOCAL, listener) }),
  };
}
