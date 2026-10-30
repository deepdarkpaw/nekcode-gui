import { createRemoteBackend, detectRemoteNek, type IRemoteBackend } from "@zcode/server/remote";
import type { NekRemoteHost } from "@zcode/shared/nek-protocol";
import type { NekConfigHostExecutor } from "../../../services/src/nek-config-api/hostExecutor.js";
import {
  createRemoteNekConfigHostExecutor,
  readRemoteConfigPaths,
  type NekRemoteConfigConnection,
} from "../../../services/src/nek-config-api/remoteHostExecutor.js";

interface ConnectedRemote {
  backend: IRemoteBackend;
  executor: NekConfigHostExecutor;
}

/** Owns the persistent remote connections used by settings/config IPC. */
export class NekRemoteConfigConnectionRegistry {
  private readonly connections = new Map<string, ConnectedRemote>();

  async connect(connectionId: string, target: NekRemoteHost["target"]): Promise<void> {
    await this.disconnect(connectionId);
    const backend = await createRemoteBackend(target);
    try {
      const detected = await detectRemoteNek(backend);
      if (detected.status !== "ready") throw new Error(detected.error ?? detected.status);
      const paths = await readRemoteConfigPaths(backend as unknown as NekRemoteConfigConnection);
      const executor = createRemoteNekConfigHostExecutor({
        id: `remote:${connectionId}`,
        home: paths.home,
        agentDir: paths.agentDir,
        connection: backend as unknown as NekRemoteConfigConnection,
      });
      this.connections.set(connectionId, { backend, executor });
    } catch (error) {
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

  dispose(): void {
    for (const connectionId of this.connections.keys()) void this.disconnect(connectionId);
    this.connections.clear();
  }
}
