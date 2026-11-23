import type { NekExtensionUiResponse, NekInteractionFrame } from "@zcode/shared/nek-protocol";
import type { NekRpcProcess } from "../nekRpcProcess.js";
import type { NekAgentCommandTarget } from "./nekAgentServiceCommands.js";
import { assertNekHistoryInputReady } from "./nekHistoryStreamSession.js";
import { NekAgentSessionResumeBase } from "./nekAgentSessionResume.js";
import {
  buildNekPlanCommand,
  readNekPlanState,
  submitFreshNekPlan,
  type NekPlanExecution,
} from "./nekPlanCommands.js";
import { NekPendingInputCancelledError } from "./nekPendingInputQueue.js";
import { bumpStateEpoch } from "./nekSessionSnapshotLoader.js";
import type { NekSessionRecord, NekSessionResult } from "./types.js";

/** 复用 service 的会话表、租约和交互桥；不另存计划或审批。 */
export abstract class NekPlanSessionBase extends NekAgentSessionResumeBase {
  protected abstract commandTarget(
    sessionKey: string,
    writable: boolean,
    forPlanBuild?: boolean,
  ): NekAgentCommandTarget;

  /** 退订只释放监听，待答请求仍由交互桥持有。 */
  onInteractionEvent(listener: (frame: NekInteractionFrame) => void): () => void {
    return this.interactions.onFrame(listener);
  }

  pendingInteractions(workspacePath: string): NekInteractionFrame[] {
    return this.interactions.pendingFrames(workspacePath);
  }

  respondInteraction(response: NekExtensionUiResponse): boolean {
    this.assertAlive();
    if (
      !("cancelled" in response && response.cancelled) &&
      "result" in response &&
      (response.result as { action?: string } | null)?.action === "implement_fresh"
    ) {
      const scope = this.interactions.planReviewScope(response.id);
      const record = scope?.sessionKey ? this.resolveRecord(scope.sessionKey) : undefined;
      if (record) this.expectFresh(record, () => undefined, this.config.timeouts.promptPreflightMs);
    }
    return this.interactions.respond(response);
  }

  /** 显式关闭 workspace 时取消阻塞请求；不是普通退订。 */
  cancelWorkspaceInteractions(workspacePath: string): void {
    this.interactions.cancelWorkspace(workspacePath);
  }

  isAwaitingPlanReview(sessionKey: string): boolean {
    const record = this.requireRecord(sessionKey);
    return this.interactions.hasPlanReview({ workspacePath: record.cwd, sessionKey: record.key });
  }

  async executePlan(
    sessionKey: string,
    input: NekPlanExecution,
  ): Promise<NekSessionResult | undefined> {
    const record = this.requireWritable(sessionKey);
    if (record.planBuild) throw new Error("计划执行请求正在提交");
    record.planBuild = true;
    try {
      return await this.withSession(sessionKey, async () => {
        await record.historyStream?.drain();
        assertNekHistoryInputReady(record);
        return await this.submitPlan(record, this.commandTarget(sessionKey, true, true), input);
      });
    } finally {
      record.planBuild = false;
    }
  }

  private async submitPlan(
    record: NekSessionRecord,
    target: NekAgentCommandTarget,
    input: NekPlanExecution,
  ): Promise<NekSessionResult | undefined> {
    const process = this.requireProcess(record);
    const observed = record.stateEpoch;
    const previousPlan = record.projector?.snapshot().config.nekReadyPlan;
    const [runtime, state] = await Promise.all([
      target.client.call({ type: "get_state" }),
      readNekPlanState(target.client),
    ]);
    const message = buildNekPlanCommand(state, input);
    const submit = async () => {
      assertNekHistoryInputReady(record);
      const scope = { workspacePath: record.cwd, sessionKey: record.key };
      const currentPlan = record.projector?.snapshot().config.nekReadyPlan;
      // 模型准入可能广播无关配置；只拒绝期间改变了生命周期或计划有效性的事件。
      const planChanged =
        currentPlan !== previousPlan &&
        (currentPlan?.path !== input.path || currentPlan.revision !== input.revision);
      if (
        runtime.sessionId !== record.sessionId ||
        record.process !== process ||
        record.closing ||
        record.stateEpoch !== observed ||
        planChanged ||
        record.phase !== "idle" ||
        runtime.isStreaming ||
        runtime.isCompacting ||
        runtime.pendingMessageCount > 0 ||
        this.pendingInputs.isCompacting(record) ||
        this.interactions.hasPending(scope)
      )
        throw new Error("会话状态已变化、仍在运行或等待回答，请刷新后重试");
      if (input.fresh) {
        await submitFreshNekPlan(
          target.client,
          message,
          (started) => this.expectFresh(record, started),
          async () => await record.historyStream?.drain(),
        );
        return this.result(record);
      }
      const ack = await target.client.call({ type: "prompt", message });
      const after = await readNekPlanState(target.client);
      if (ack.disposition !== "handled" || after.mode !== "agent")
        throw new Error("nek 没有开始执行计划，请查看会话提示");
      return undefined;
    };
    return await (target.modelRuntime ? target.modelRuntime.run("input", submit) : submit());
  }

  /** 只在明确选择新会话执行后，接纳 nek 在原进程内发出的新会话 reset。 */
  private expectFresh(
    record: NekSessionRecord,
    started: () => void,
    deadlineMs?: number,
  ): () => void {
    const process = this.requireProcess(record);
    if (!record.historyStream) throw new Error("nek history stream is not attached");
    return record.historyStream.expectPlanSession(
      {
        replace: (frame) => this.movePlanSession(record, process, frame),
        started: () => {
          this.emit({ type: "catalog_changed", topic: "index", cwd: record.cwd });
          started();
        },
      },
      deadlineMs,
    );
  }

  private movePlanSession(
    record: NekSessionRecord,
    process: NekRpcProcess,
    frame: { sessionId: string; sessionPath?: string },
  ): void {
    const { sessionId, sessionPath } = frame;
    if (
      !sessionId ||
      !sessionPath ||
      !record.path ||
      record.closing ||
      record.process !== process ||
      this.byPath.has(sessionPath) ||
      this.sessions.has(sessionPath)
    )
      throw new Error("nek did not identify a distinct new plan session");
    const source: NekSessionRecord = {
      key: record.key,
      sessionId: record.sessionId,
      path: record.path,
      cwd: record.cwd,
      projectTrusted: record.projectTrusted,
      projector: record.projector,
      historyMetadata: record.historyMetadata,
      readonly: false,
      closing: false,
      phase: "idle",
    };
    const childProjector = this.createProjector({ ...source, sessionId });
    childProjector.beginFreshHistory();
    this.pool.moveSession(record.key, sessionPath, process);
    this.interactions.cancelScope({ workspacePath: record.cwd, sessionKey: record.key });
    this.pendingInputs.cancel(
      record,
      new NekPendingInputCancelledError("nek 已进入计划的新会话，原输入未发送"),
    );
    // 源订阅仍持有原 projector；只有进程与租约迁到子会话，不能改写原快照身份。
    source.projector?.flushNow();
    this.createRecord(source);
    record.key = sessionPath;
    record.path = sessionPath;
    record.sessionId = sessionId;
    record.projector = childProjector;
    record.historyMetadata = undefined;
    record.state = undefined;
    record.phase = "idle";
    record.createdThisRun = true;
    if (record.interactionScope) record.interactionScope.sessionKey = sessionPath;
    bumpStateEpoch(record);
    this.createRecord(record);
  }
}
