/**
 * nek RPC 事件到 renderer status frame 的投影。
 *
 * 该通道不保存第二份会话状态：它只转发 RPC 事实，并在订阅/打开会话时
 * 读取一次权威快照。状态归约的唯一 owner 仍是 renderer 的 useNekStatusStore。
 */
import { Emitter, type Event } from "@zcode/rpc";
import type {
  NekAgentSessionEvent,
  NekExtensionEvent,
  NekRpcEvent,
  NekState,
  NekStatusFrame,
  NekSubagentRecord,
  NekStatusFrameEvent,
  NekStatusSnapshot,
} from "@zcode/shared/nek-protocol";
import {
  NEK_STATUS_FRAME_MAX_PLANS,
  NEK_STATUS_FRAME_MAX_QUEUE_ITEMS,
  NEK_STATUS_FRAME_MAX_SUBAGENTS,
  NEK_STATUS_FRAME_MAX_TEXT,
  NEK_STATUS_FRAME_MAX_TODOS,
} from "@zcode/shared/nek-protocol";
import type { NekAgentService } from "../service/nekAgentService.js";
import { isNekState, type NekAgentServiceEvent } from "../service/types.js";
import { workspaceKey } from "./frameHelpers.js";
import type { NekWorkspaceTarget } from "./types.js";

const STATUS_EVENT_TYPES = new Set<NekAgentSessionEvent["type"]>([
  "agent_start",
  "agent_settled",
  "message_start",
  "message_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
]);

type StatusLogger = { warn: (...args: unknown[]) => void } | undefined;
const MAX_STATUS_SNAPSHOT_SESSIONS = 20;

const boundText = (value: string): string => value.slice(0, NEK_STATUS_FRAME_MAX_TEXT);

function boundSubagent(record: NekSubagentRecord): NekSubagentRecord {
  return {
    ...record,
    description: boundText(record.description),
    type: boundText(record.type),
    ...(record.model ? { model: boundText(record.model) } : {}),
    ...(record.activity ? { activity: boundText(record.activity) } : {}),
    ...(record.error ? { error: boundText(record.error) } : {}),
    ...(record.finalText ? { finalText: boundText(record.finalText) } : {}),
    ...(record.sessionFile ? { sessionFile: boundText(record.sessionFile) } : {}),
  };
}

export function boundNekStatusState(state: NekState): NekState {
  return {
    ...state,
    todos: state.todos.slice(0, NEK_STATUS_FRAME_MAX_TODOS).map((todo) => ({
      ...todo,
      content: boundText(todo.content),
    })),
    plans: state.plans.slice(-NEK_STATUS_FRAME_MAX_PLANS).map((plan) => ({
      ...plan,
      path: boundText(plan.path),
      name: boundText(plan.name),
      overview: boundText(plan.overview),
      todos: plan.todos.slice(0, NEK_STATUS_FRAME_MAX_TODOS).map((todo) => ({
        ...todo,
        content: boundText(todo.content),
      })),
    })),
    subagents: state.subagents
      .slice(-NEK_STATUS_FRAME_MAX_SUBAGENTS)
      .map((record) => boundSubagent(record)),
    ...(state.activePlanPath ? { activePlanPath: boundText(state.activePlanPath) } : {}),
  };
}

export function projectNekStatusEvent(event: NekRpcEvent): NekStatusFrameEvent | null {
  if (STATUS_EVENT_TYPES.has(event.type as NekAgentSessionEvent["type"])) {
    if (event.type === "queue_update") {
      return {
        ...event,
        steering: event.steering
          .slice(0, NEK_STATUS_FRAME_MAX_QUEUE_ITEMS)
          .map((message) => boundText(message)),
        followUp: event.followUp
          .slice(0, NEK_STATUS_FRAME_MAX_QUEUE_ITEMS)
          .map((message) => boundText(message)),
      };
    }
    if (event.type === "message_start" || event.type === "message_end") {
      return { type: event.type, message: null };
    }
    if (event.type === "compaction_end") {
      return {
        ...event,
        ...(event.errorMessage ? { errorMessage: boundText(event.errorMessage) } : {}),
      };
    }
    if (event.type === "auto_retry_start") {
      return { ...event, errorMessage: boundText(event.errorMessage) };
    }
    if (event.type === "auto_retry_end") {
      return { ...event, ...(event.finalError ? { finalError: boundText(event.finalError) } : {}) };
    }
    if (event.type === "summarization_retry_scheduled") {
      return { ...event, errorMessage: boundText(event.errorMessage) };
    }
    return event as Extract<NekStatusFrameEvent, { type: typeof event.type }>;
  }
  if (event.type !== "extension_event") return null;
  if (event.name === "nek.state" && isNekState(event.payload)) {
    return { ...event, payload: boundNekStatusState(event.payload) } as NekExtensionEvent;
  }
  if (event.name === "nek.subagent" && isNekSubagentRecord(event.payload)) {
    return { ...event, payload: boundSubagent(event.payload) };
  }
  return null;
}

function isNekSubagentRecord(value: unknown): value is NekSubagentRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<NekSubagentRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.description === "string" &&
    typeof record.type === "string" &&
    typeof record.background === "boolean" &&
    (record.status === "running" ||
      record.status === "completed" ||
      record.status === "errored" ||
      record.status === "aborted") &&
    typeof record.startedAt === "number"
  );
}

export class NekAgentStatusChannel {
  private readonly emitters = new Map<string, Emitter<NekStatusFrame>>();
  private subscriberCount = 0;
  private detachService: (() => void) | undefined;

  constructor(
    private readonly service: NekAgentService,
    private readonly logger: StatusLogger,
  ) {}

  onDynamic(target: NekWorkspaceTarget): Event<NekStatusFrame> {
    const key = workspaceKey(target);
    return (listener) => {
      const disposable = this.emitter(key).event(listener);
      void this.publishExisting(target);
      return disposable;
    };
  }

  publish(target: NekWorkspaceTarget, sessionKey: string): void {
    if (this.subscriberCount === 0) return;
    void this.publishSnapshot(target, sessionKey);
  }

  dispose(): void {
    this.detachService?.();
    this.detachService = undefined;
    this.subscriberCount = 0;
    for (const emitter of this.emitters.values()) emitter.dispose();
    this.emitters.clear();
  }

  private emitter(key: string): Emitter<NekStatusFrame> {
    const existing = this.emitters.get(key);
    if (existing) return existing;
    const emitter = new Emitter<NekStatusFrame>({
      onWillAddFirstListener: () => this.attachService(),
      onDidRemoveLastListener: () => {
        this.subscriberCount = Math.max(0, this.subscriberCount - 1);
        if (this.subscriberCount === 0) {
          this.detachService?.();
          this.detachService = undefined;
        }
        this.emitters.delete(key);
      },
    });
    this.emitters.set(key, emitter);
    return emitter;
  }

  private attachService(): void {
    this.subscriberCount += 1;
    this.detachService ??= this.service.onEvent((event) => this.publishServiceEvent(event));
  }

  private publishServiceEvent(event: NekAgentServiceEvent): void {
    if (event.type === "rpc_event") {
      const projected = projectNekStatusEvent(event.event);
      if (projected)
        this.fire(event.session.cwd, {
          kind: "event",
          sessionKey: event.session.sessionId,
          event: projected,
        });
      return;
    }
    if (event.type === "process_exit") {
      this.fire(event.session.cwd, {
        kind: "event",
        sessionKey: event.session.sessionId,
        event: { type: "process_exit" },
      });
      return;
    }
    if (event.type === "state")
      this.publish({ workspacePath: event.session.cwd }, event.session.sessionKey);
  }

  private async publishExisting(target: NekWorkspaceTarget): Promise<void> {
    const sessions = this.service
      .listOpenSessions(target.workspacePath)
      .slice(-MAX_STATUS_SNAPSHOT_SESSIONS);
    for (const session of sessions) {
      await this.publishSnapshot(target, session.sessionKey);
    }
  }

  private async publishSnapshot(target: NekWorkspaceTarget, sessionKey: string): Promise<void> {
    try {
      const snapshot = await this.service.getStatusSnapshot(sessionKey);
      this.fire(target.workspacePath, {
        kind: "snapshot",
        sessionKey: snapshot.sessionKey,
        snapshot: boundNekStatusSnapshot(snapshot),
      });
    } catch (error) {
      this.logger?.warn("failed to publish nek status snapshot", error);
    }
  }

  private fire(cwd: string, frame: NekStatusFrame): void {
    this.emitters.get(workspaceKey({ workspacePath: cwd }))?.fire(frame);
  }
}

export function boundNekStatusSnapshot(snapshot: NekStatusSnapshot): NekStatusSnapshot {
  return { ...snapshot, state: boundNekStatusState(snapshot.state) };
}
