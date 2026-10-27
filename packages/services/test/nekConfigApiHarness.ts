/**
 * 设置中心后端测试台：内存执行器 + 假目标表 + 假控制进程。
 *
 * 不接触真实 nek、不联网、不写真实文件：所有配置都在内存执行器里，
 * 控制进程的响应由测试显式编排。
 */
import { join } from "node:path";
import assert from "node:assert/strict";
import { parse as parseJsonc } from "jsonc-parser";
import type { NekAuthProviderStatusWire } from "@zcode/shared/nek-protocol";
import type {
  NekConfigTarget,
  NekConfigTargetInfo,
  NekControlClient,
  NekRpcCommandOfType,
  NekRpcCommandType,
  NekRpcResponseDataFor,
  NekStructuredUiRequest,
  NekStructuredUiResponse,
} from "../src/nek-config-api/index.js";
import { NekConfigApi, createMemoryNekConfigHostExecutor } from "../src/nek-config-api/index.js";
import type {
  MemoryNekConfigHostExecutor,
  NekConfigSessionHandle,
  NekConfigTargetHost,
  NekStructuredHandler,
} from "../src/nek-config-api/index.js";

export const HOME = "/home/nek";
export const AGENT_DIR = join(HOME, ".nek", "agent");
export const PROJECT = "/work/proj";
export const PROJECT_DIR = join(PROJECT, ".nek");
export const REMOTE_HOME = "/home/remote";
export const REMOTE_AGENT_DIR = join(REMOTE_HOME, ".nek", "agent");

export const LOCAL: NekConfigTarget = { kind: "local" };
export const REMOTE: NekConfigTarget = { kind: "remote", connectionId: "ssh-1" };

/** 记录命令、可编排登录流程的假控制进程。 */
export class FakeControlClient implements NekControlClient {
  readonly commands: Array<{ type: string } & Record<string, unknown>> = [];
  readonly authStatus: NekAuthProviderStatusWire[];
  private authListeners = new Set<(record: never) => void>();
  private handler: NekStructuredHandler | undefined;
  private loginResolve: ((value: { provider: string }) => void) | undefined;
  private loginReject: ((error: Error) => void) | undefined;
  private reloadDeferred = false;
  readonly respondCalls: NekStructuredUiResponse[] = [];

  constructor(options: { authStatus?: NekAuthProviderStatusWire[]; loginDeferred?: boolean } = {}) {
    this.authStatus = options.authStatus ?? [];
    this.reloadDeferred = options.loginDeferred ?? false;
  }

  get structuredHandler(): NekStructuredHandler | undefined {
    return this.handler;
  }

  setStructuredHandler(handler: NekStructuredHandler | undefined): void {
    this.handler = handler;
  }

  onAuthEvent(listener: (record: never) => void): () => void {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }

  respondExtensionUi(response: NekStructuredUiResponse): void {
    this.respondCalls.push(response);
  }

  async close(): Promise<void> {
    this.loginReject?.(new Error("control process closed"));
    this.loginReject = undefined;
  }

  // ---- 测试编排 ----

  emitAuthEvent(record: unknown): void {
    for (const listener of this.authListeners) (listener as (value: unknown) => void)(record);
    void this.authStatus;
  }

  async pushPrompt(request: NekStructuredUiRequest): Promise<NekStructuredUiResponse | undefined> {
    return await this.handler?.(request, new AbortController().signal);
  }

  completeLogin(): void {
    this.loginResolve?.({ provider: "anthropic" });
    this.loginResolve = undefined;
  }

  failLogin(message: string): void {
    this.loginReject?.(new Error(message));
    this.loginReject = undefined;
  }

  async call<C extends NekRpcCommandType>(
    command: NekRpcCommandOfType<C>,
  ): Promise<NekRpcResponseDataFor<C>> {
    this.commands.push(command as { type: string } & Record<string, unknown>);
    const type = command.type;
    if (type === "auth_login") {
      return (await new Promise<{ provider: string }>((resolve, reject) => {
        this.loginResolve = resolve;
        this.loginReject = reject;
      })) as NekRpcResponseDataFor<C>;
    }
    if (type === "auth_status") {
      return { providers: this.authStatus } as NekRpcResponseDataFor<C>;
    }
    if (type === "auth_logout") return {} as NekRpcResponseDataFor<C>;
    if (type === "reload") {
      return { deferred: this.reloadDeferred, diagnostics: [] } as NekRpcResponseDataFor<C>;
    }
    if (type === "validate_config") return { diagnostics: [] } as NekRpcResponseDataFor<C>;
    if (type === "set_project_trust") return {} as NekRpcResponseDataFor<C>;
    if (type === "test_web_search") {
      return { ok: true, latencyMs: 12, resultCount: 3 } as NekRpcResponseDataFor<C>;
    }
    if (type === "mcp_test") {
      return { ok: true, latencyMs: 5, tools: [{ name: "ping" }] } as NekRpcResponseDataFor<C>;
    }
    if (type === "get_available_models") {
      return {
        models: [
          {
            id: "claude-sonnet-4-5",
            name: "Claude Sonnet 4.5",
            api: "anthropic-messages",
            provider: "anthropic",
            baseUrl: "https://api.anthropic.com",
            input: ["text"],
            cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
            reasoning: true,
            thinkingLevelMap: { off: null, low: "low" },
            contextWindow: 200_000,
            maxTokens: 64_000,
          },
        ],
      } as NekRpcResponseDataFor<C>;
    }
    if (type === "get_model_catalog") {
      return { models: [] } as NekRpcResponseDataFor<C>;
    }
    if (type === "fetch_provider_models") {
      return {
        ok: true,
        endpoint: "https://draft.example.com/models",
        models: [{ id: "draft-model" }],
      } as NekRpcResponseDataFor<C>;
    }
    if (type === "test_provider") {
      return { ok: true, latencyMs: 7 } as NekRpcResponseDataFor<C>;
    }
    if (type === "get_project_trust") {
      return {
        cwd: PROJECT,
        trusted: null,
        defaultProjectTrust: "ask",
        resources: [],
      } as NekRpcResponseDataFor<C>;
    }
    throw new Error(`unexpected control command: ${type}`);
  }
}

export interface Harness {
  api: NekConfigApi;
  local: MemoryNekConfigHostExecutor;
  remote: MemoryNekConfigHostExecutor;
  control: FakeControlClient;
  sessions: NekConfigSessionHandle[];
  disconnect(): void;
  useControl(client: FakeControlClient): void;
}

export interface HarnessOptions {
  localFiles?: Record<string, string>;
  remoteFiles?: Record<string, string>;
  control?: FakeControlClient;
  autoReload?: boolean;
  pollSeconds?: number;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const local = createMemoryNekConfigHostExecutor({
    home: HOME,
    agentDir: AGENT_DIR,
    files: options.localFiles ?? {},
    id: "local",
  });
  const remote = createMemoryNekConfigHostExecutor({
    home: REMOTE_HOME,
    agentDir: REMOTE_AGENT_DIR,
    files: options.remoteFiles ?? {},
    id: "remote",
  });
  const harness: Harness = {
    api: undefined as unknown as NekConfigApi,
    local,
    remote,
    control: options.control ?? new FakeControlClient(),
    sessions: [],
    disconnect: () => undefined,
    useControl: (client) => {
      harness.control = client;
    },
  };
  let connected = true;
  let currentControl = harness.control;

  const hosts: NekConfigTargetHost = {
    executor: (target) => {
      if (!connected) return undefined;
      return target.kind === "local" ? local : remote;
    },
    listTargets: async (): Promise<NekConfigTargetInfo[]> => [
      {
        target: LOCAL,
        hostname: "memory-local",
        label: "Local",
        connected,
        nek: { state: "ready", version: "0.3.2", agentDir: AGENT_DIR },
      },
      {
        target: REMOTE,
        hostname: "memory-remote",
        label: "remote",
        connected,
        nek: { state: "ready", version: "0.3.2", agentDir: REMOTE_AGENT_DIR },
      },
    ],
  };

  harness.api = new NekConfigApi({
    hosts,
    config: {
      autoReload: options.autoReload ?? false,
      remoteConfigPollSeconds: options.pollSeconds ?? 3600,
      watchDebounceMs: 5,
    },
    sessions: { sessions: () => harness.sessions },
    control: async () => currentControl,
  });
  harness.disconnect = () => {
    connected = false;
  };
  const useControl = harness.useControl;
  harness.useControl = (client) => {
    currentControl = client;
    useControl(client);
  };
  return harness;
}

/** 断言抛出的是指定 code 的 `NekConfigError`。 */
export async function expectNekError(
  run: () => Promise<unknown>,
  code: string,
): Promise<Error & { code: string; fieldErrors?: Record<string, string> }> {
  try {
    await run();
  } catch (error) {
    const shaped = error as Error & { code?: string; fieldErrors?: Record<string, string> };
    assert.equal(
      shaped.code,
      code,
      `expected code ${code}, got ${String(shaped.code)}: ${shaped.message}`,
    );
    return shaped as Error & { code: string; fieldErrors?: Record<string, string> };
  }
  throw new Error(`expected the call to fail with ${code}`);
}

/** 读取视图 → 写入值（界面就是把视图原样送回来，只把 apiKey 换成显式指令）。 */
export function toWrite(
  view: { apiKey?: unknown; overridesBuiltin?: boolean } & Record<string, unknown>,
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  const { apiKey: _apiKey, overridesBuiltin: _flag, ...rest } = view;
  return { ...rest, ...patch };
}

/** 读配置（允许 `//` 注释：models.json 与用户手改的文件都可能带注释）。 */
export function readJson(executor: MemoryNekConfigHostExecutor, path: string): unknown {
  const content = executor.files.get(path);
  assert.ok(content !== undefined, `missing file ${path}`);
  return parseJsonc(content, [], { allowTrailingComma: true, disallowComments: false });
}
