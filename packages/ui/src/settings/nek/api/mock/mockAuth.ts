/**
 * mock 登录流程：
 * - anthropic：auth_url（浏览器自动回调）+ manual_code 提示（粘贴授权码）；
 * - openai-codex：device_code + auth_url + manual_code；设备码模式在 `deviceAutoCompleteMs` 后自动完成；
 * - 授权码包含 "bad" / "fail" 时失败（invalid_grant），否则成功。
 * 事件按 loginId 缓存，订阅时回放（建议真实实现也这样做，避免订阅前的事件丢失）。
 */
import type { NekConfigTarget, NekLoginEvent, NekLoginSession } from "@zcode/shared/nek-protocol";
import type { MockMachine } from "./mockMachine.js";

interface LoginRun {
  loginId: string;
  provider: string;
  machine: MockMachine;
  events: NekLoginEvent[];
  listeners: Set<(event: NekLoginEvent) => void>;
  finished: boolean;
  timers: Array<ReturnType<typeof setTimeout>>;
}

const MAX_RUNS = 16;
const CALLBACK_PORTS: Record<string, number> = { anthropic: 53692, "openai-codex": 1455 };

export class MockLoginSimulator {
  private readonly runs = new Map<string, LoginRun>();
  private seq = 0;

  constructor(private readonly options: { deviceAutoCompleteMs: number; stepMs: number }) {}

  start(machine: MockMachine, target: NekConfigTarget, provider: string): NekLoginSession {
    this.seq += 1;
    const loginId = `login-${this.seq}`;
    const run: LoginRun = {
      loginId,
      provider,
      machine,
      events: [],
      listeners: new Set(),
      finished: false,
      timers: [],
    };
    this.runs.set(loginId, run);
    this.trim();
    const port = CALLBACK_PORTS[provider];
    const forwardedPorts = target.kind === "remote" && port ? [port] : [];
    this.schedule(run, this.options.stepMs, () => this.emitIntro(run));
    if (provider === "openai-codex") {
      this.schedule(run, this.options.deviceAutoCompleteMs, () => this.complete(run));
    }
    return { loginId, forwardedPorts };
  }

  subscribe(loginId: string, listener: (event: NekLoginEvent) => void): () => void {
    const run = this.runs.get(loginId);
    if (!run) {
      return () => undefined;
    }
    run.listeners.add(listener);
    for (const event of run.events) {
      listener(event);
    }
    return () => {
      run.listeners.delete(listener);
    };
  }

  answer(loginId: string, promptId: string, value: string): void {
    const run = this.runs.get(loginId);
    if (!run || run.finished) {
      throw { code: "validation", message: `Login ${loginId} is not active` };
    }
    this.emit(run, { type: "prompt_cancelled", promptId });
    if (/bad|fail/i.test(value)) {
      this.finish(run, {
        type: "failed",
        message: "invalid_grant: the authorization code is invalid or expired",
      });
      return;
    }
    this.emit(
      run,
      this.authEvent(run, { type: "progress", message: "Exchanging authorization code…" }),
    );
    this.schedule(run, this.options.stepMs, () => this.complete(run));
  }

  cancel(loginId: string): void {
    const run = this.runs.get(loginId);
    if (run && !run.finished) {
      this.finish(run, { type: "cancelled" });
    }
  }

  /** 测试用：立即完成设备码登录。 */
  complete(run: LoginRun | string): void {
    const current = typeof run === "string" ? this.runs.get(run) : run;
    if (!current || current.finished) {
      return;
    }
    const status = current.machine.auth.get(current.provider);
    if (status) {
      current.machine.auth.set(current.provider, {
        ...status,
        kind: "oauth",
        expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
      });
    }
    this.finish(current, { type: "done", provider: current.provider });
  }

  private emitIntro(run: LoginRun): void {
    const state = Math.random().toString(36).slice(2, 10);
    if (run.provider === "openai-codex") {
      this.emit(
        run,
        this.authEvent(run, {
          type: "device_code",
          userCode: "NEK-4821",
          verificationUri: "https://auth.openai.com/codex/device",
          intervalSeconds: 5,
          expiresInSeconds: 900,
        }),
      );
    }
    this.emit(
      run,
      this.authEvent(run, {
        type: "auth_url",
        url: `https://auth.example.com/oauth/authorize?client=nek&state=${state}`,
        instructions: "Complete the login in your browser.",
      }),
    );
    this.emit(run, {
      type: "prompt",
      promptId: `${run.loginId}-code`,
      payload: {
        provider: run.provider,
        prompt: {
          type: "manual_code",
          message: "Paste the authorization code",
          placeholder: "code#state",
        },
      },
    });
  }

  private authEvent(
    run: LoginRun,
    event: Extract<NekLoginEvent, { type: "auth_event" }>["record"]["event"],
  ): NekLoginEvent {
    return { type: "auth_event", record: { type: "auth_event", provider: run.provider, event } };
  }

  private emit(run: LoginRun, event: NekLoginEvent): void {
    run.events.push(event);
    for (const listener of run.listeners) {
      listener(event);
    }
  }

  private finish(run: LoginRun, event: NekLoginEvent): void {
    run.finished = true;
    for (const timer of run.timers) {
      clearTimeout(timer);
    }
    this.emit(run, event);
  }

  private schedule(run: LoginRun, ms: number, task: () => void): void {
    run.timers.push(
      setTimeout(() => {
        if (!run.finished) {
          task();
        }
      }, ms),
    );
  }

  private trim(): void {
    while (this.runs.size > MAX_RUNS) {
      const oldest = this.runs.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.runs.delete(oldest);
    }
  }
}
