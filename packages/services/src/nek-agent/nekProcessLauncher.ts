import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import type { NekGuiInfo } from "@zcode/shared/nek-protocol";
import {
  shouldSpawnInDetachedProcessGroup,
  terminateProcessTree,
} from "#src/process/processTreeTerminator.js";
import type { NekRpcProcessExit, NekRpcProcessHandle } from "./nekRpcClient.js";

/**
 * 用 `nek gui-info --json` 给出的启动信息在本机 spawn nek（不经 shell）。
 *
 * `NekGuiInfo.node.path` + `launch.args` 是 `nek.cmd` / `nek` 启动器内部那条命令的等价物，
 * 所以 GUI 不需要猜 node 位置、也不需要经过 shell 拼参数。
 */

export interface NekSpawnOptions {
  guiInfo: NekGuiInfo;
  cwd: string;
  /** 追加在 `launch.args` 之后的参数（通常以 `--mode rpc` 开头）。 */
  args?: string[];
  /** 额外环境变量；`undefined` 值表示不覆盖。 */
  env?: Record<string, string | undefined>;
  log?: { warn: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
}

export interface NekSpawnedProcess {
  child: ChildProcess;
  handle: NekRpcProcessHandle;
  /** spawn 失败时（例如 node 路径不存在）为 undefined。 */
  pid: number | undefined;
}

/**
 * spawn 一个 nek 进程，返回可直接交给 `NekRpcClient` 的句柄。
 *
 * `kill` 会回收整棵进程树：nek 会派生子进程（bash 工具、MCP server、子代理），
 * 只杀 root 会留下孤儿。POSIX 上同时以独立进程组 spawn，便于按组回收。
 */
export function spawnNekProcess(options: NekSpawnOptions): NekSpawnedProcess {
  const { guiInfo } = options;
  const argv = [...guiInfo.launch.args, ...(options.args ?? [])];
  const detached = shouldSpawnInDetachedProcessGroup();
  const startedAtMs = Date.now();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value !== undefined) env[key] = value;
  }

  const child = spawn(guiInfo.node.path, argv, {
    cwd: options.cwd,
    env,
    windowsHide: true,
    detached,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const exitListeners = new Set<(info: NekRpcProcessExit) => void>();
  let exitInfo: NekRpcProcessExit | undefined;
  const emitExit = (info: NekRpcProcessExit) => {
    if (exitInfo) return;
    exitInfo = info;
    for (const listener of Array.from(exitListeners)) listener(info);
  };
  child.once("exit", (code, signal) => emitExit({ code, signal }));
  // spawn 自身失败（ENOENT/EACCES）只有 error 事件，没有 exit。
  child.once("error", (error) => emitExit({ code: null, signal: null, error }));
  child.once("close", (code, signal) => emitExit({ code, signal }));

  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    if (exitInfo) return;
    options.log?.warn("terminating nek process tree", child.pid);
    terminateProcessTree(child, {
      ownedProcessGroupId: detached ? child.pid : undefined,
      ownedProcessStartedAtMs: startedAtMs,
      log: options.log,
    });
  };

  const { stdin, stdout, stderr } = child;
  if (!stdin || !stdout || !stderr) {
    // 走到这里说明 spawn 的 stdio 配置被改坏了；显式失败胜过拿 null 当流用。
    throw new Error("nek process stdio pipes are unavailable");
  }

  const handle: NekRpcProcessHandle = {
    stdin,
    stdout,
    stderr,
    kill,
    onExit: (listener) => {
      exitListeners.add(listener);
      if (exitInfo) listener(exitInfo);
      return () => {
        exitListeners.delete(listener);
      };
    },
  };

  return { child, handle, pid: child.pid };
}
