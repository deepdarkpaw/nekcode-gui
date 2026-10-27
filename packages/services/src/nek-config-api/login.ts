/**
 * 账号登录（OAuth / API Key）的事件流。
 *
 * 契约的两条要求决定了实现形状：
 * 1. `startLogin` 必须先返回 `loginId`，界面拿到 id 之后才订阅 `onLoginEvent`，
 *    所以事件**必须缓存并在订阅时回放**，否则第一批 `auth_url` / 设备码会丢；
 * 2. 需要用户输入时，nek 通过 structured UI 请求（`kind: "auth.prompt"`）询问，
 *    这里把请求 id 当作 `promptId`，用户答复就是一条 `extension_ui_response`。
 *
 * 事件转换：structured 请求 → `{type:"prompt"}`；请求被撤销 → `prompt_cancelled`；
 * `auth_event` → `{type:"auth_event"}`；RPC 结果 → `done` / `failed`。
 */
import type {
  NekAuthPromptPayload,
  NekAuthProviderStatus,
  NekAuthProviderStatusWire,
  NekConfigTarget,
  NekLoginEvent,
  NekLoginSession,
  NekStructuredUiRequest,
  NekStructuredUiResponse,
} from "@zcode/shared/nek-protocol";
import { NEK_STRUCTURED_KINDS } from "@zcode/shared/nek-protocol";
import type { NekControlClient } from "./control.js";
import { validationError } from "./errors.js";

/** OAuth 回调端口（nek 内置 provider）；远程目标需要 host 转发这些端口。 */
export const LOGIN_CALLBACK_PORTS: Readonly<Record<string, number>> = {
  anthropic: 53692,
  "openai-codex": 1455,
};

/**
 * `auth_status` 的线上形状 → 契约的 `state`。
 *
 * nek 只给 `kind` 与 `expiresAt`：
 * - `oauth` 且已过期 → `expired`（用户需要重新登录）；
 * - `oauth` 未过期 / 非 oauth → `ok`；
 * - `refresh_failed` 目前没有来源（nek 不暴露刷新结果），见报告里的 nek 侧缺项。
 */
function normalizeAuthStatus(status: NekAuthProviderStatusWire): NekAuthProviderStatus {
  if (status.state) return { ...status, state: status.state };
  const expired =
    status.kind === "oauth" &&
    typeof status.expiresAt === "string" &&
    Date.parse(status.expiresAt) <= Date.now();
  return { ...status, state: expired ? "expired" : "ok" };
}

const MAX_RUNS = 16;
const MAX_EVENTS = 200;

interface PendingPrompt {
  resolve: (response: NekStructuredUiResponse) => void;
}

interface LoginRun {
  loginId: string;
  provider: string;
  target: NekConfigTarget;
  events: NekLoginEvent[];
  listeners: Set<(event: NekLoginEvent) => void>;
  prompts: Map<string, PendingPrompt>;
  detachAuth: () => void;
  finished: boolean;
}

export interface NekLoginManagerOptions {
  /** 取目标机器的控制进程（懒启动）。 */
  control: (target: NekConfigTarget) => Promise<NekControlClient>;
  /** 登录在没有待答复提示时被取消：终止控制进程以中断 nek 侧的流程。 */
  abort?: (target: NekConfigTarget) => Promise<void>;
  /** 远程目标需要端口转发时由 host 提供；返回真正建立的本机端口。 */
  forwardPorts?: (target: NekConfigTarget, ports: number[]) => Promise<number[]>;
  logger?: { warn: (...args: unknown[]) => void };
}

function targetKeyOf(target: NekConfigTarget): string {
  return target.kind === "local" ? "local" : `remote:${target.connectionId}`;
}

export class NekLoginManager {
  private readonly runs = new Map<string, LoginRun>();
  /** 每个目标当前活跃的登录：nek 的提示不带 loginId，只能按目标路由。 */
  private readonly activeByTarget = new Map<string, LoginRun>();
  private sequence = 0;

  constructor(private readonly options: NekLoginManagerOptions) {}

  async authStatus(target: NekConfigTarget): Promise<NekAuthProviderStatus[]> {
    const control = await this.options.control(target);
    const data = await control.call({ type: "auth_status" });
    return data.providers.map(normalizeAuthStatus);
  }

  async logout(target: NekConfigTarget, provider: string): Promise<void> {
    const control = await this.options.control(target);
    await control.call({ type: "auth_logout", provider });
  }

  /** 开始登录：立刻返回 `loginId`，nek 侧的 `auth_login` 在后台跑完。 */
  async start(target: NekConfigTarget, provider: string): Promise<NekLoginSession> {
    const control = await this.options.control(target);
    this.sequence += 1;
    const loginId = `login-${this.sequence}`;
    const run: LoginRun = {
      loginId,
      provider,
      target,
      events: [],
      listeners: new Set(),
      prompts: new Map(),
      detachAuth: () => undefined,
      finished: false,
    };
    this.runs.set(loginId, run);
    this.trimRuns();
    run.detachAuth = control.onAuthEvent((record) => {
      if (record.provider !== provider) return;
      this.emit(run, { type: "auth_event", record });
    });
    const key = targetKeyOf(target);
    this.activeByTarget.set(key, run);
    control.setStructuredHandler(async (request, signal) => {
      const active = this.activeByTarget.get(key);
      if (!active) return { type: "extension_ui_response", id: request.id, cancelled: true };
      return await this.handlePrompt(active, request, signal);
    });
    const forwardedPorts = await this.forwardPorts(target, provider);
    void control
      .call({ type: "auth_login", provider, method: "oauth" })
      .then(() => {
        this.finish(run, { type: "done", provider });
      })
      .catch((error: unknown) => {
        this.finish(run, {
          type: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        // 只摘掉自己：并发开始的下一次登录可能已经接管了处理器。
        if (this.activeByTarget.get(key) === run) this.activeByTarget.delete(key);
      });
    return { loginId, forwardedPorts };
  }

  /** 答复登录提示：`promptId` 就是 nek 侧 structured 请求的 id。 */
  async answer(loginId: string, promptId: string, value: string): Promise<void> {
    const run = this.runs.get(loginId);
    if (!run || run.finished)
      throw validationError(`login ${loginId} is not active`, { loginId: "not active" });
    const pending = run.prompts.get(promptId);
    if (!pending) {
      throw validationError(`login ${loginId} has no pending prompt ${promptId}`, {
        promptId: "not pending",
      });
    }
    run.prompts.delete(promptId);
    pending.resolve({ type: "extension_ui_response", id: promptId, result: { value } });
    this.emit(run, { type: "prompt_cancelled", promptId });
  }

  /** 取消登录：有提示就答"取消"（nek 据此中止），没提示就终止控制进程。 */
  async cancel(loginId: string): Promise<void> {
    const run = this.runs.get(loginId);
    if (!run || run.finished) return;
    const prompts = [...run.prompts.entries()];
    for (const [promptId, pending] of prompts) {
      run.prompts.delete(promptId);
      pending.resolve({ type: "extension_ui_response", id: promptId, cancelled: true });
      this.emit(run, { type: "prompt_cancelled", promptId });
    }
    this.finish(run, { type: "cancelled" });
    if (prompts.length === 0) {
      // 没有待答复的提示时，nek 侧还在等浏览器回调；只能中断进程才算真的取消。
      await this.options.abort?.(run.target).catch((error: unknown) => {
        this.options.logger?.warn(
          "failed to abort the control process after cancelling a login",
          error,
        );
      });
    }
  }

  /** 订阅某次登录的事件；订阅时回放已经发生过的事件。 */
  subscribe(loginId: string, listener: (event: NekLoginEvent) => void): () => void {
    const run = this.runs.get(loginId);
    if (!run) return () => undefined;
    run.listeners.add(listener);
    for (const event of run.events) listener(event);
    return () => {
      run.listeners.delete(listener);
    };
  }

  /** 供 `copy` 使用：开始登录并等到结束（有提示需要用户输入时视为失败）。 */
  async runToCompletion(target: NekConfigTarget, provider: string): Promise<void> {
    const session = await this.start(target, provider);
    await new Promise<void>((resolve, reject) => {
      const detach = this.subscribe(session.loginId, (event) => {
        if (event.type === "done") {
          detach();
          resolve();
        } else if (event.type === "failed") {
          detach();
          reject(
            validationError(`login ${provider} failed: ${event.message}`, {
              provider: "login failed",
            }),
          );
        } else if (event.type === "cancelled") {
          detach();
          reject(validationError(`login ${provider} was cancelled`, { provider: "cancelled" }));
        } else if (event.type === "prompt") {
          detach();
          void this.cancel(session.loginId);
          reject(
            validationError(
              `login ${provider} on the target machine requires user input: sign in there instead`,
              { provider: "requires user input" },
            ),
          );
        }
      });
    });
  }

  dispose(): void {
    for (const run of this.runs.values()) {
      run.detachAuth();
      run.listeners.clear();
    }
    this.runs.clear();
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  private async handlePrompt(
    run: LoginRun,
    request: NekStructuredUiRequest,
    signal: AbortSignal,
  ): Promise<NekStructuredUiResponse | undefined> {
    if (run.finished) return { type: "extension_ui_response", id: request.id, cancelled: true };
    if (request.kind !== NEK_STRUCTURED_KINDS.authPrompt) {
      // 登录期间只处理 auth.prompt；别的结构化请求不属于这次登录，直接取消，绝不让 nek 挂住。
      this.options.logger?.warn("unexpected structured request during login", request.kind);
      return { type: "extension_ui_response", id: request.id, cancelled: true };
    }
    const payload = request.payload as NekAuthPromptPayload;
    const response = new Promise<NekStructuredUiResponse>((resolve) => {
      run.prompts.set(request.id, { resolve });
    });
    signal.addEventListener(
      "abort",
      () => {
        const pending = run.prompts.get(request.id);
        if (!pending) return;
        run.prompts.delete(request.id);
        pending.resolve({ type: "extension_ui_response", id: request.id, cancelled: true });
        this.emit(run, { type: "prompt_cancelled", promptId: request.id });
      },
      { once: true },
    );
    this.emit(run, { type: "prompt", promptId: request.id, payload });
    return await response;
  }

  private async forwardPorts(target: NekConfigTarget, provider: string): Promise<number[]> {
    if (target.kind !== "remote") return [];
    const ports = LOGIN_CALLBACK_PORTS[provider];
    if (ports === undefined) return [];
    if (!this.options.forwardPorts) {
      this.options.logger?.warn(
        `no port forwarding configured; ${provider} login on the remote target needs a manual code`,
      );
      return [];
    }
    return await this.options.forwardPorts(target, [ports]);
  }

  private emit(run: LoginRun, event: NekLoginEvent): void {
    if (run.finished) return;
    run.events.push(event);
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
    for (const listener of Array.from(run.listeners)) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger?.warn("login event listener threw", error);
      }
    }
  }

  private finish(run: LoginRun, event: NekLoginEvent): void {
    if (run.finished) return;
    this.emit(run, event);
    run.finished = true;
    run.detachAuth();
    if (this.activeByTarget.get(targetKeyOf(run.target)) === run) {
      this.activeByTarget.delete(targetKeyOf(run.target));
    }
    for (const [promptId, pending] of run.prompts) {
      pending.resolve({ type: "extension_ui_response", id: promptId, cancelled: true });
    }
    run.prompts.clear();
  }

  private trimRuns(): void {
    while (this.runs.size > MAX_RUNS) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) return;
      const run = this.runs.get(oldest);
      run?.detachAuth();
      this.runs.delete(oldest);
    }
  }
}
