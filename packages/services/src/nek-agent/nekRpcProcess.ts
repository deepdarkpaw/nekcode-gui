import type { NekGuiInfo } from "@zcode/shared/nek-protocol";
import { spawnNekProcess } from "./nekProcessLauncher.js";
import type { NekRpcClientLogger, NekRpcClientOptions, NekRpcProcessExit } from "./nekRpcClient.js";
import { NekRpcClient } from "./nekRpcClient.js";
import type { NekPooledProcess } from "./nekProcessPool.js";

/**
 * 把一个 nek 进程（客户端 + 进程树回收）包成进程池认识的句柄。
 *
 * 参数拼装集中在这里，便于 GUI 与测试用同一套规则：
 * `--mode rpc [--control] [--session <path>] [--approve|--no-approve] <extraArgs>`。
 */

export interface NekRpcProcessArgsOptions {
  /** 控制进程（`--mode rpc --control`）：不创建会话、不加载扩展与 MCP。 */
  control?: boolean;
  /** 要打开的会话文件路径；省略表示新会话。 */
  sessionPath?: string;
  /** 项目信任决定；`undefined` 表示不传（沿用 nek 的默认询问行为）。 */
  approve?: boolean;
  /** 追加参数（`--provider`、`--model` 等）。 */
  extraArgs?: string[];
}

/** 组装 `nek` 的 argv（不含 `NekGuiInfo.launch.args` 前缀）。 */
export function buildNekRpcArgs(options: NekRpcProcessArgsOptions = {}): string[] {
  const args = ["--mode", "rpc"];
  if (options.control) args.push("--control");
  if (options.sessionPath) args.push("--session", options.sessionPath);
  if (options.approve === true) args.push("--approve");
  if (options.approve === false) args.push("--no-approve");
  args.push(...(options.extraArgs ?? []));
  return args;
}

export interface NekRpcProcessOptions extends NekRpcProcessArgsOptions {
  guiInfo: NekGuiInfo;
  cwd: string;
  env?: Record<string, string | undefined>;
  client?: Omit<NekRpcClientOptions, "logger">;
  logger?: NekRpcClientLogger;
}

export interface NekRpcProcess extends NekPooledProcess {
  client: NekRpcClient;
  guiInfo: NekGuiInfo;
  pid: number | undefined;
  /** 进程退出信息（未退出时 undefined）。 */
  exitInfo: () => NekRpcProcessExit | undefined;
}

/** spawn 一个 nek RPC 进程并接上协议客户端。 */
export function createNekRpcProcess(options: NekRpcProcessOptions): NekRpcProcess {
  const spawned = spawnNekProcess({
    guiInfo: options.guiInfo,
    cwd: options.cwd,
    args: buildNekRpcArgs(options),
    env: options.env,
    log: options.logger,
  });
  let exit: NekRpcProcessExit | undefined;
  spawned.handle.onExit((info) => {
    exit = info;
  });
  const client = new NekRpcClient(spawned.handle, {
    ...options.client,
    logger: options.logger,
  });
  return {
    client,
    guiInfo: options.guiInfo,
    pid: spawned.pid,
    exitInfo: () => exit,
    onExit: (listener) => spawned.handle.onExit(() => listener()),
    dispose: async () => {
      await client.close();
    },
  };
}
