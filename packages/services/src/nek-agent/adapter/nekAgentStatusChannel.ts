/**
 * nek RPC 事件到 renderer status frame 的投影与分发。
 *
 * 该通道不保存第二份会话状态：它只转发 RPC 事实，并在订阅/打开会话时读取一次权威快照。
 * 状态归约的唯一 owner 仍是 renderer 的 `useNekStatusStore`。
 *
 * 订阅是懒的：没有 renderer 订阅时不向服务登记（不产生额外 RPC），最后一个订阅者离开后
 * 连同服务订阅一起回收。所有外发数组/文本先按 `NEK_STATUS_FRAME_MAX_*` 裁剪，
 * 这样迟到 renderer 或异常扩展都不会把无界载荷推进 IPC。
 */
import { Emitter, toDisposable, type Event } from "@zcode/rpc";
import {
  NEK_STATUS_FRAME_MAX_PLANS,
  NEK_STATUS_FRAME_MAX_QUEUE_ITEMS,
  NEK_STATUS_FRAME_MAX_SNAPSHOT_SESSIONS,
  NEK_STATUS_FRAME_MAX_SUBAGENTS,
  NEK_STATUS_FRAME_MAX_TEXT,
  NEK_STATUS_FRAME_MAX_TODOS,
  type NekExtensionEvent,
  type NekRpcEvent,
  type NekState,
  type NekStatusFrame,
  type NekStatusFrameEvent,
  type NekStatusSnapshot,
  type NekStatusQueue,
  type NekSubagentRecord,
} from "@zcode/shared/nek-protocol";
import { isNekSubagentRecord } from "../projection/nekSubagentRecords.js";
import { isNekState, type NekAgentServiceEvent, type NekSession } from "../service/types.js";
import { workspaceKey } from "./frameHelpers.js";
import type { NekWorkspaceTarget } from "./types.js";

/** 通道真正依赖的服务面：便于在不启动 nek 进程的情况下测试投影与分发。 */
export interface NekStatusChannelService {
  onEvent(listener: (event: NekAgentServiceEvent) => void): () => void;
  listOpenSessions(cwd: string): NekSession[];
  getStatusSnapshot(sessionKey: string): Promise<NekStatusSnapshot>;
}

export interface NekStatusChannelLogger {
  warn: (...args: unknown[]) => void;
}

/** 单个 workspace 的订阅条目：emitter 与订阅计数一一对应。 */
interface WorkspaceFeedEntry {
  emitter: Emitter<NekStatusFrame>;
  workspacePath: string;
  listeners: number;
}

const boundText = (value: string): string => value.slice(0, NEK_STATUS_FRAME_MAX_TEXT);
const boundList = (values: readonly string[]): string[] =>
  values.slice(0, NEK_STATUS_FRAME_MAX_QUEUE_ITEMS).map(boundText);
const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

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

/** 把 `nek.get_state` 的完整快照裁到 store 的上限；裁剪是幂等的。 */
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

export function boundNekStatusSnapshot(snapshot: NekStatusSnapshot): NekStatusSnapshot {
  return { ...snapshot, state: boundNekStatusState(snapshot.state) };
}

/** `clear_queue` 的回包也要有界，否则一次异常队列就能把 store 撑爆。 */
export function boundNekStatusQueue(queue: NekStatusQueue): NekStatusQueue {
  return { steering: boundList(queue.steering), followUp: boundList(queue.followUp) };
}

function projectExtensionEvent(event: NekExtensionEvent): NekExtensionEvent | null {
  if (event.name === "nek.state" && isNekState(event.payload)) {
    return { ...event, payload: boundNekStatusState(event.payload) };
  }
  if (event.name === "nek.subagent" && isNekSubagentRecord(event.payload)) {
    return { ...event, payload: boundSubagent(event.payload) };
  }
  return null;
}

/**
 * 一条 RPC 事件 → status 帧事件；返回 `null` 表示这条记录与状态视图无关（或形状不认识）。
 *
 * 认不出的载荷一律丢弃，与 renderer reducer 的 `normalizeEvent` 保持同一口径：
 * 状态视图宁可缺一项，也不把半个快照渲染成"全部清空"。
 */
export function projectNekStatusEvent(event: NekRpcEvent): NekStatusFrameEvent | null {
  switch (event.type) {
    case "agent_start":
    case "agent_settled":
    case "compaction_start":
    case "summarization_retry_attempt_start":
    case "summarization_retry_finished":
      return event;
    case "message_start":
    case "message_end":
      // 只用于把用量置为过期（ST-7）；消息载荷不进入 status feed。
      return { type: event.type };
    case "queue_update":
      if (!isStringArray(event.steering) || !isStringArray(event.followUp)) return null;
      return {
        type: "queue_update",
        steering: boundList(event.steering),
        followUp: boundList(event.followUp),
      };
    case "compaction_end":
      return {
        ...event,
        ...(event.errorMessage ? { errorMessage: boundText(event.errorMessage) } : {}),
      };
    case "auto_retry_start":
      return { ...event, errorMessage: boundText(event.errorMessage) };
    case "auto_retry_end":
      return { ...event, ...(event.finalError ? { finalError: boundText(event.finalError) } : {}) };
    case "summarization_retry_scheduled":
      return { ...event, errorMessage: boundText(event.errorMessage) };
    case "extension_event":
      return projectExtensionEvent(event);
    default:
      return null;
  }
}

export class NekAgentStatusChannel {
  private readonly entries = new Map<string, WorkspaceFeedEntry>();
  /** workspacePath → 该路径下的订阅键（同一路径可能有多个 workspaceIdentity）。 */
  private readonly keysByPath = new Map<string, Set<string>>();
  private subscriberCount = 0;
  private detachService: (() => void) | undefined;

  constructor(
    private readonly service: NekStatusChannelService,
    private readonly logger: NekStatusChannelLogger | undefined,
  ) {}

  onDynamic(target: NekWorkspaceTarget): Event<NekStatusFrame> {
    const key = workspaceKey(target);
    return (listener) => {
      const entry = this.attach(key, target.workspacePath);
      const disposable = entry.emitter.event(listener);
      if (entry.listeners === 1) void this.publishExisting(target);
      return toDisposable(() => {
        disposable.dispose();
        this.detach(key);
      });
    };
  }

  /** 新会话/恢复会话后补一帧快照；没有订阅者时完全不发 RPC。 */
  publish(target: NekWorkspaceTarget, sessionKey: string): void {
    if (this.subscriberCount === 0) return;
    void this.publishSnapshot(target.workspacePath, sessionKey);
  }

  /** 会话被关闭：renderer 必须丢掉该会话的本地状态。 */
  publishClosed(target: NekWorkspaceTarget, sessionKey: string): void {
    if (this.subscriberCount === 0) return;
    this.fire(target.workspacePath, { kind: "closed", sessionKey });
  }

  dispose(): void {
    this.detachService?.();
    this.detachService = undefined;
    this.subscriberCount = 0;
    for (const entry of this.entries.values()) entry.emitter.dispose();
    this.entries.clear();
    this.keysByPath.clear();
  }

  private attach(key: string, workspacePath: string): WorkspaceFeedEntry {
    this.subscriberCount += 1;
    const existing = this.entries.get(key);
    if (existing) {
      existing.listeners += 1;
      return existing;
    }
    const entry: WorkspaceFeedEntry = {
      emitter: new Emitter<NekStatusFrame>(),
      workspacePath,
      listeners: 1,
    };
    this.entries.set(key, entry);
    const keys = this.keysByPath.get(workspacePath);
    if (keys) keys.add(key);
    else this.keysByPath.set(workspacePath, new Set([key]));
    this.detachService ??= this.service.onEvent((event) => this.publishServiceEvent(event));
    return entry;
  }

  private detach(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.listeners -= 1;
    this.subscriberCount = Math.max(0, this.subscriberCount - 1);
    if (entry.listeners > 0) return;
    this.entries.delete(key);
    const keys = this.keysByPath.get(entry.workspacePath);
    keys?.delete(key);
    if (keys && keys.size === 0) this.keysByPath.delete(entry.workspacePath);
    entry.emitter.dispose();
    if (this.subscriberCount > 0) return;
    this.detachService?.();
    this.detachService = undefined;
  }

  private publishServiceEvent(event: NekAgentServiceEvent): void {
    if (event.type === "process_exit") {
      this.fire(event.session.cwd, {
        kind: "event",
        sessionKey: event.session.sessionId,
        event: { type: "process_exit" },
      });
      return;
    }
    if (event.type !== "rpc_event") return;
    const projected = projectNekStatusEvent(event.event);
    if (!projected) return;
    this.fire(event.session.cwd, {
      kind: "event",
      sessionKey: event.session.sessionId,
      event: projected,
    });
  }

  /** 迟订阅补齐：只补最近 `NEK_STATUS_FRAME_MAX_SNAPSHOT_SESSIONS` 个活会话。 */
  private async publishExisting(target: NekWorkspaceTarget): Promise<void> {
    const sessions = this.service
      .listOpenSessions(target.workspacePath)
      .filter((session) => !session.readonly)
      .slice(-NEK_STATUS_FRAME_MAX_SNAPSHOT_SESSIONS);
    for (const session of sessions) {
      await this.publishSnapshot(target.workspacePath, session.sessionKey);
    }
  }

  private async publishSnapshot(workspacePath: string, sessionKey: string): Promise<void> {
    try {
      const snapshot = await this.service.getStatusSnapshot(sessionKey);
      if (this.subscriberCount === 0) return;
      this.fire(workspacePath, {
        kind: "snapshot",
        sessionKey: snapshot.sessionKey,
        snapshot: boundNekStatusSnapshot(snapshot),
      });
    } catch (error) {
      // 快照失败不能静默：没有快照时状态卡保持上一份数据，日志给出可追的失败原因。
      this.logger?.warn("failed to publish nek status snapshot", error);
    }
  }

  private fire(workspacePath: string, frame: NekStatusFrame): void {
    const keys = this.keysByPath.get(workspacePath);
    if (!keys) return;
    for (const key of keys) this.entries.get(key)?.emitter.fire(frame);
  }
}
