/**
 * 本机目标的主机表：本机执行器 + 可选的远程连接表。
 *
 * 远程执行器（SSH 或远端 gui-server）由 host 注入；这里只负责把它们和外层契约的
 * `NekConfigTargetInfo` 拼起来，并给出本机 nek 的安装状态。
 */
import type { NekConfigTarget, NekConfigTargetInfo } from "@zcode/shared/nek-protocol";
import { NekLocator, NekLocatorError } from "../nek-agent/nekLocator.js";
import { createLocalNekConfigHostExecutor } from "./hostExecutor.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import type { NekConfigTargetHost } from "./runtime.js";

/** 已连接的远程主机（由 host 的 SSH/连接管理实现）。 */
export interface NekConfigRemoteHosts {
  list: () => Promise<
    Array<{
      connectionId: string;
      label: string;
      detail?: string;
      connected: boolean;
      nek: NekConfigTargetInfo["nek"];
    }>
  >;
  executor: (connectionId: string) => NekConfigHostExecutor | undefined;
}

export interface CreateLocalTargetHostOptions {
  executor?: NekConfigHostExecutor;
  locator?: NekLocator;
  remotes?: NekConfigRemoteHosts;
  /** 本机显示名，默认「本机」。 */
  label?: string;
}

/** 本机 nek 的安装状态（`gui-info`）。 */
export async function localNekState(
  executor: NekConfigHostExecutor,
  locator: NekLocator,
): Promise<NekConfigTargetInfo["nek"]> {
  try {
    const located = await locator.locate();
    return { state: "ready", version: located.info.nekVersion, agentDir: located.info.agentDir };
  } catch (error) {
    if (error instanceof NekLocatorError) {
      if (error.code === "not_found") return { state: "not_installed" };
      if (error.code === "incompatible") {
        return { state: "incompatible", version: "unknown", message: error.message };
      }
      return { state: "unknown", message: error.message };
    }
    return { state: "unknown", message: error instanceof Error ? error.message : String(error) };
  }
}

export function createLocalNekConfigTargetHost(
  options: CreateLocalTargetHostOptions = {},
): NekConfigTargetHost {
  const executor = options.executor ?? createLocalNekConfigHostExecutor();
  const locator = options.locator ?? new NekLocator();
  const remotes = options.remotes;

  return {
    executor: (target: NekConfigTarget) => {
      if (target.kind === "local") return executor;
      return remotes?.executor(target.connectionId);
    },

    listTargets: async () => {
      const info: NekConfigTargetInfo = {
        target: { kind: "local" },
        label: options.label ?? "Local",
        connected: true,
        nek: await localNekState(executor, locator),
      };
      const targets: NekConfigTargetInfo[] = [info];
      for (const remote of (await remotes?.list()) ?? []) {
        targets.push({
          target: { kind: "remote", connectionId: remote.connectionId },
          label: remote.label,
          ...(remote.detail ? { detail: remote.detail } : {}),
          connected: remote.connected,
          nek: remote.nek,
        });
      }
      return targets;
    },
  };
}
