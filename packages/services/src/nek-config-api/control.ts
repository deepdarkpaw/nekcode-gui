/**
 * 控制进程（`nek --mode rpc --control`）：每台目标机器一个，懒启动、崩溃后退避重启。
 *
 * 为什么不复用会话进程：设置页在没有打开任何会话时也要工作，而控制进程不创建会话、
 * 不加载扩展与 MCP，正好用来跑 `auth_*` / `get_model_catalog` / `validate_config` /
 * `mcp_test` 这类"读配置、试连接"的命令（见 `NEK_CONTROL_COMMANDS`）。
 */
import type {
  NekAuthEventRecord,
  NekConfigTarget,
  NekExtensionUiResponse,
  NekRpcCommandOfType,
  NekRpcCommandType,
  NekRpcResponseDataFor,
  NekStructuredUiRequest,
  NekStructuredUiResponse,
} from "@zcode/shared/nek-protocol";
import { NekRpcClient as RpcClient } from "../nek-agent/nekRpcClient.js";
import { NekLocatorError } from "../nek-agent/nekLocator.js";
import { NekProcessPool } from "../nek-agent/nekProcessPool.js";
import type { NekPooledProcess } from "../nek-agent/nekProcessPool.js";
import { asNekConfigError, nekUnavailable } from "./errors.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";

/** 结构化交互处理器（登录期间挂在控制进程上）。`signal` 在 nek 侧撤销请求时 abort。 */
export type NekStructuredHandler = (
  request: NekStructuredUiRequest,
  signal: AbortSignal,
) => Promise<NekStructuredUiResponse | undefined> | NekStructuredUiResponse | undefined;

/** 设置页需要的最小控制进程能力。 */
export interface NekControlClient {
  call: <C extends NekRpcCommandType>(command: NekRpcCommandOfType<C>) => Promise<NekRpcResponseDataFor<C>>;
  onAuthEvent: (listener: (record: NekAuthEventRecord) => void) => () => void;
  respondExtensionUi: (response: NekExtensionUiResponse) => void;
  setStructuredHandler: (handler: NekStructuredHandler | undefined) => void;
  close: () => Promise<void>;
}

export interface NekControlClientLogger {
  warn: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

interface ControlProcess extends NekPooledProcess {
  client: RpcClient;
}

function isRpcClient(value: unknown): value is RpcClient {
  return typeof value === "object" && value !== null && "call" in value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailable(error: unknown): Error {
  if (error instanceof NekLocatorError) {
    switch (error.code) {
      case "not_found":
        return nekUnavailable("nek is not installed on the target");
      case "incompatible":
        return nekUnavailable(`nek version is not compatible: ${error.message}`);
      default:
        return nekUnavailable(`cannot start nek: ${error.message}`);
    }
  }
  const normalized = asNekConfigError(error);
  return nekUnavailable(`cannot start the nek control process: ${normalized.message}`);
}

/**
 * 建一个控制进程客户端：`spawnNek` 由执行器提供（本机 spawn，远程由远端执行），
 * 进程复用 `nekProcessPool` 的懒启动与退避重启。
 */
export async function createNekControlClient(options: {
  target: NekConfigTarget;
  executor: NekConfigHostExecutor;
  logger?: NekControlClientLogger;
}): Promise<NekControlClient> {
  const { executor, logger } = options;
  let structuredHandler: NekStructuredHandler | undefined;
  const pool = new NekProcessPool<ControlProcess>({
    createSessionProcess: async () => {
      throw nekUnavailable("control pool does not manage session processes");
    },
    createControlProcess: async () => {
      let handle;
      try {
        handle = await executor.spawnNek(["--mode", "rpc", "--control"]);
      } catch (error) {
        throw unavailable(error);
      }
      const client = new RpcClient(handle, {
        requestIdPrefix: "control",
        logger,
        extensionUi: {
          structured: async (request, signal) =>
            structuredHandler ? await structuredHandler(request, signal) : undefined,
        },
      });
      return {
        client,
        dispose: async () => {
          await client.close();
        },
        onExit: (listener) => client.onExit(() => listener()),
      };
    },
    logger,
  });

  const control = await pool.ensureControl().catch((error: unknown) => {
    void pool.dispose();
    throw unavailable(error);
  });
  if (!isRpcClient(control.client)) {
    void pool.dispose();
    throw nekUnavailable("the control process handle has no RPC client");
  }
  return {
    call: async (command) => control.client.call(command),
    onAuthEvent: (listener) => control.client.onAuthEvent(listener),
    respondExtensionUi: (response) => control.client.respondExtensionUi(response),
    setStructuredHandler: (handler) => {
      structuredHandler = handler;
    },
    close: async () => {
      await pool.dispose();
    },
  };
}

export { errorMessage };
