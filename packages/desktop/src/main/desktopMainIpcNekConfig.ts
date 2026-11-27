import {
  createRemoteBackend,
  detectRemoteNek,
  type IRemoteBackend,
  type LocalPortForwardHandle,
} from "@zcode/server/remote";
import type { NekRemoteHost, NekConfigTarget } from "@zcode/shared/nek-protocol";
import type { NekConfigHostExecutor } from "../../../services/src/nek-config-api/hostExecutor.js";
import {
  createRemoteNekConfigHostExecutor,
  detectRemoteConfigRuntime,
} from "../../../services/src/nek-config-api/remoteHostExecutor.js";
import type { NekLoginPortForward } from "../../../services/src/nek-config-api/runtime.js";

interface ConnectedRemote {
  backend: IRemoteBackend;
  executor: NekConfigHostExecutor;
  /** `nek gui-info` 报出的版本，用于主机列表展示。 */
  nekVersion: string;
}

interface RemoteConfigConnectionRegistryOptions {
  createBackend?: typeof createRemoteBackend;
  detectNek?: typeof detectRemoteNek;
  detectConfigRuntime?: typeof detectRemoteConfigRuntime;
}

/**
 * Owns the connections the settings/config IPC uses for remote hosts.
 *
 * The window-level remote registry lives in the host process and serves workspaces, not the
 * main-process settings service, so main keeps its own connection per saved host: connect on
 * demand (`connectHost`), drop on disconnect/delete, and answer `not_connected` otherwise.
 */
export class NekRemoteConfigConnectionRegistry {
  private readonly connections = new Map<string, ConnectedRemote>();
  private readonly connecting = new Map<string, Promise<void>>();
  private readonly createBackend: typeof createRemoteBackend;
  private readonly detectNek: typeof detectRemoteNek;
  private readonly detectConfigRuntime: typeof detectRemoteConfigRuntime;

  constructor(options: RemoteConfigConnectionRegistryOptions = {}) {
    this.createBackend = options.createBackend ?? createRemoteBackend;
    this.detectNek = options.detectNek ?? detectRemoteNek;
    this.detectConfigRuntime = options.detectConfigRuntime ?? detectRemoteConfigRuntime;
  }

  connect(connectionId: string, target: NekRemoteHost["target"]): Promise<void> {
    if (this.connections.has(connectionId)) return Promise.resolve();
    const current = this.connecting.get(connectionId);
    if (current) return current;
    const attempt: Promise<void> = Promise.resolve()
      .then(() => this.establish(connectionId, target, attempt))
      .finally(() => {
        if (this.connecting.get(connectionId) === attempt) this.connecting.delete(connectionId);
      });
    this.connecting.set(connectionId, attempt);
    return attempt;
  }

  isConnecting(connectionId: string): boolean {
    return this.connecting.has(connectionId);
  }

  private async establish(
    connectionId: string,
    target: NekRemoteHost["target"],
    attempt: Promise<void>,
  ): Promise<void> {
    const backend = await this.createBackend(target);
    try {
      const detected = await this.detectNek(backend);
      if (detected.status !== "ready" || !detected.info) {
        throw new Error(detected.error ?? detected.status);
      }
      // 配置脚本与控制进程都用 gui-info 报出的那份 Node，不再在远端 PATH 上另找。
      const runtime = await this.detectConfigRuntime(backend, detected.info);
      const executor = createRemoteNekConfigHostExecutor({
        id: `remote:${connectionId}`,
        runtime,
        connection: backend,
      });
      if (this.connecting.get(connectionId) !== attempt)
        throw new Error("Remote settings connection was cancelled");
      this.connections.set(connectionId, {
        backend,
        executor,
        nekVersion: detected.info.nekVersion,
      });
    } catch (error) {
      // 连接失败必须回到"未连接"状态，否则界面会以为远端配置可读。
      await backend.dispose();
      throw error;
    }
  }

  async disconnect(connectionId: string): Promise<void> {
    this.connecting.delete(connectionId);
    const connected = this.connections.get(connectionId);
    if (!connected) return;
    this.connections.delete(connectionId);
    await connected.backend.dispose();
  }

  has(connectionId: string): boolean {
    return this.connections.has(connectionId);
  }

  executor(connectionId: string): NekConfigHostExecutor | undefined {
    return this.connections.get(connectionId)?.executor;
  }

  async forwardLoginPorts(target: NekConfigTarget, ports: number[]): Promise<NekLoginPortForward> {
    if (target.kind !== "remote") {
      return { ports: [], close: async () => undefined };
    }
    const connection = this.connections.get(target.connectionId);
    if (!connection) throw new Error(`remote host is not connected: ${target.connectionId}`);
    if (!connection.backend.forwardLocalPortToRemote) {
      throw new Error(`remote host does not support OAuth port forwarding: ${target.connectionId}`);
    }

    const forwards: LocalPortForwardHandle[] = [];
    try {
      for (const port of ports) {
        forwards.push(await connection.backend.forwardLocalPortToRemote(port, port));
      }
    } catch (error) {
      await Promise.all(forwards.map((forward) => forward.close().catch(() => undefined)));
      throw error;
    }

    let closed = false;
    return {
      ports: forwards.map((forward) => forward.localPort),
      close: async () => {
        if (closed) return;
        closed = true;
        const failures: unknown[] = [];
        for (const forward of forwards) {
          try {
            await forward.close();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "failed to close remote OAuth port forwarding");
        }
      },
    };
  }

  nekVersion(connectionId: string): string | undefined {
    return this.connections.get(connectionId)?.nekVersion;
  }

  async dispose(): Promise<void> {
    this.connecting.clear();
    const pending = Array.from(this.connections.keys(), async (connectionId) => {
      await this.disconnect(connectionId);
    });
    this.connections.clear();
    await Promise.all(pending);
  }
}
