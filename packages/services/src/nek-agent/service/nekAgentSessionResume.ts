import { NekAgentServiceRuntimeBase } from "./nekAgentServiceRuntimeMethods.js";
import { isNekSessionSnapshot, type NekSessionRecord, type NekSessionResult } from "./types.js";

const MAX_RESUME_FLIGHTS = 128;

/** Service-owned resume state machine; inherited records, pool and projectors remain one owner. */
export abstract class NekAgentSessionResumeBase extends NekAgentServiceRuntimeBase {
  private readonly resumeFlights = new Map<string, Promise<NekSessionResult>>();

  /** 同一文件共享一次恢复；失败移除 flight，允许显式重试。 */
  async resumeSession(input: { sessionPath: string; cwd?: string }): Promise<NekSessionResult> {
    this.assertAlive();
    const pending = this.resumeFlights.get(input.sessionPath);
    if (pending) return await pending;
    if (this.resumeFlights.size >= MAX_RESUME_FLIGHTS)
      throw new Error(`nek session resume limit exceeded (${MAX_RESUME_FLIGHTS})`);
    const flight = this.resumeSessionOnce(input);
    this.resumeFlights.set(input.sessionPath, flight);
    try {
      return await flight;
    } finally {
      if (this.resumeFlights.get(input.sessionPath) === flight)
        this.resumeFlights.delete(input.sessionPath);
    }
  }

  /** 崩溃重连仍须由恢复流程重新检查权威锁，不能强行升级为 writable。 */
  async restartSession(sessionKey: string): Promise<NekSessionResult> {
    const record = this.requireRecord(sessionKey);
    if (!record.path) throw new Error("cannot restart a session without a session path");
    return await this.resumeSession({ sessionPath: record.path, cwd: record.cwd });
  }

  /** 原始打开错误保持可见；回收失败只记录，不替换原始失败原因。 */
  protected async reclaimQuietly(record: NekSessionRecord, message: string): Promise<void> {
    try {
      await this.pool.reclaimSession(record.key, "dispose");
    } catch (error) {
      this.logger?.warn(message, error);
    }
  }

  private async resumeSessionOnce(input: {
    sessionPath: string;
    cwd?: string;
  }): Promise<NekSessionResult> {
    const existing = this.byPath.get(input.sessionPath);
    if (existing?.process && !existing.readonly) return this.result(existing);
    const control = await this.pool.ensureControl();
    const snapshot = await control.client.call({
      type: "read_session_snapshot",
      sessionPath: input.sessionPath,
    });
    this.assertAlive();
    if (!isNekSessionSnapshot(snapshot))
      throw new Error("nek returned an invalid session snapshot");
    if (snapshot.session.locked) return this.openLockedSnapshot(snapshot, input.cwd);

    const record =
      existing ??
      this.createRecord({
        key: input.sessionPath,
        sessionId: snapshot.session.id,
        path: input.sessionPath,
        cwd: input.cwd ?? snapshot.session.cwd,
        phase: "idle",
        readonly: false,
        closing: false,
      });
    try {
      const approval = await this.resolveProjectApproval(record.cwd);
      this.assertAlive();
      record.readonly = false;
      record.lockedBy = undefined;
      record.lockHolder = undefined;
      record.snapshot = undefined;
      await this.openProcess(record, {
        sessionKey: record.key,
        cwd: record.cwd,
        sessionPath: input.sessionPath,
        approve: approval,
        extensionUi: this.extensionUiFor({ workspacePath: record.cwd, sessionKey: record.key }),
      });
      this.assertAlive();
      if (record.state?.isStreaming) {
        this.emit({
          type: "resume_notice",
          session: this.publicSession(record),
          message: "正在继续上次中断的回合",
        });
        this.setPhase(record, "running");
      }
      return this.result(record);
    } catch (error) {
      this.detachProcess(record);
      await this.reclaimQuietly(record, "failed to reclaim a failed nek session process");
      if (!existing) this.removeRecord(record);
      else this.setPhase(record, "error");
      throw error;
    }
  }
}
