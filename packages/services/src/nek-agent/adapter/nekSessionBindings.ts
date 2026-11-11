import type { NekSessionSummary } from "@zcode/shared/nek-protocol";
import { sessionMapKey } from "./frameHelpers.js";
import type { NekSessionBinding, NekWorkspaceTarget } from "./types.js";
import type { NekSession, NekSessionResult } from "../service/types.js";
import { nekOpenDurationMs } from "../service/nekSessionOpenTiming.js";

const MAX_BINDINGS = 5_000;
const MAX_RESTORE_FLIGHTS = 128;

interface NekSessionBindingPorts {
  getSession(sessionKey: string): NekSession | undefined;
  listSessions(target: NekWorkspaceTarget): Promise<NekSessionSummary[]>;
  resumeSession(input: { workspacePath: string; sessionPath: string }): Promise<NekSessionResult>;
}

/** Adapter-owned binding admission; service remains the owner of processes, locks and snapshots. */
export class NekSessionBindings {
  private readonly entries = new Map<string, NekSessionBinding>();
  private readonly restoreFlights = new Map<string, Promise<NekSessionBinding>>();
  private disposed = false;

  constructor(private readonly ports: NekSessionBindingPorts) {}

  bind(target: NekWorkspaceTarget, result: NekSessionResult): void {
    this.assertAlive();
    if (!this.find(target, result.sessionId) && this.entries.size >= MAX_BINDINGS)
      throw new Error(`nek session binding limit exceeded (${MAX_BINDINGS})`);
    this.entries.set(sessionMapKey(target, result.sessionId), {
      target,
      sessionKey: result.sessionKey,
      sessionId: result.sessionId,
      ...(result.sessionPath ? { sessionPath: result.sessionPath } : {}),
    });
  }

  /** All active operations enter here; identity aliases share actual cwd + sessionId. */
  async ensure(
    target: NekWorkspaceTarget,
    sessionId: string,
    refreshLocked = false,
  ): Promise<NekSessionBinding> {
    this.assertAlive();
    const existing = this.find(target, sessionId);
    const session = existing ? this.ports.getSession(existing.sessionKey) : undefined;
    if (existing && session && session.phase !== "error" && !(refreshLocked && session.readonly))
      return existing;
    if (existing && !session) this.remove(target, sessionId);
    const key = sessionMapKey(target, sessionId);
    const pending = this.restoreFlights.get(key);
    if (pending) return await pending;
    if (this.restoreFlights.size >= MAX_RESTORE_FLIGHTS)
      throw new Error(`nek session restore limit exceeded (${MAX_RESTORE_FLIGHTS})`);
    const flight = this.restore(target, sessionId);
    this.restoreFlights.set(key, flight);
    try {
      return await flight;
    } finally {
      if (this.restoreFlights.get(key) === flight) this.restoreFlights.delete(key);
    }
  }

  async waitForPending(target: NekWorkspaceTarget, sessionId: string): Promise<void> {
    await this.restoreFlights.get(sessionMapKey(target, sessionId));
  }

  require(target: NekWorkspaceTarget, sessionId: string): NekSessionBinding {
    const binding = this.find(target, sessionId);
    if (!binding)
      throw new Error(`nek session ${sessionId} is not open in ${target.workspacePath}`);
    return binding;
  }

  resolve(target: NekWorkspaceTarget, sessionId?: string): string | undefined {
    if (sessionId) return this.find(target, sessionId)?.sessionKey;
    return [...this.entries.values()].find(
      (binding) => binding.target.workspacePath === target.workspacePath,
    )?.sessionKey;
  }

  remove(target: NekWorkspaceTarget, sessionId: string): void {
    this.entries.delete(sessionMapKey(target, sessionId));
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.restoreFlights.clear();
  }

  private find(target: NekWorkspaceTarget, sessionId: string): NekSessionBinding | undefined {
    return this.entries.get(sessionMapKey(target, sessionId));
  }

  private async restore(target: NekWorkspaceTarget, sessionId: string): Promise<NekSessionBinding> {
    const lookupStartedAt = performance.now();
    const summary = (await this.ports.listSessions(target)).find((item) => item.id === sessionId);
    const taskMetaReadMs = nekOpenDurationMs(lookupStartedAt);
    if (!summary) throw new Error(`nek session ${sessionId} was not found`);
    const result = await this.ports.resumeSession({
      workspacePath: target.workspacePath,
      sessionPath: summary.path,
    });
    this.assertAlive();
    // 返回副本：共享在途恢复可共享本次 timing，之后 warm ensure 只读不带 timing 的表项。
    return {
      ...this.require(target, sessionId),
      openTiming: { version: 1, ...result.openTiming, taskMetaReadMs },
    };
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("nek session bindings have been disposed");
  }
}
