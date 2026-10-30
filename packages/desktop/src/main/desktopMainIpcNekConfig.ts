import { createRemoteBackend, detectRemoteNek, type IRemoteBackend } from "@zcode/server/remote";
import type { NekRemoteHost } from "@zcode/shared/nek-protocol";
import type { NekConfigHostExecutor } from "../../../services/src/nek-config-api/hostExecutor.js";
import {
  createRemoteNekConfigHostExecutor,
  detectRemoteConfigRuntime,
} from "../../../services/src/nek-config-api/remoteHostExecutor.js";

interface ConnectedRemote {
  backend: IRemoteBackend;
  executor: NekConfigHostExecutor;
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

  async connect(connectionId: string, target: NekRemoteHost["target"]): Promise<void> {
    await this.disconnect(connectionId);
    const backend = await createRemoteBackend(target);
    try {
      const detected = await detectRemoteNek(backend);
      if (detected.status !== "ready") throw new Error(detected.error ?? detected.status);
      const runtime = await detectRemoteConfigRuntime(backend);
      const executor = createRemoteNekConfigHostExecutor({
        id: `remote:${connectionId}`,
        runtime,
        connection: backend,
      });
      this.connections.set(connectionId, { backend, executor });
    } catch (error) {
      // 连接失败必须回到"未连接"状态，否则界面会以为远端配置可读。
      await backend.dispose();
      throw error;
    }
  }

  async disconnect(connectionId: string): Promise<void> {
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

  async dispose(): Promise<void> {
    const pending = Array.from(this.connections.keys(), async (connectionId) => {
      await this.disconnect(connectionId);
    });
    this.connections.clear();
    await Promise.all(pending);
  }
}
