/**
 * 模型选择契约测试的共享替身：只记录调用并返回编排好的事实。
 *
 * 不接触真实 nek、不读真实文件；需要控制“读取何时完成”时用 `deferred()`。
 */
import type {
  NekAuthProviderStatus,
  NekCatalogModel,
  NekConfigScope,
  NekConfigTarget,
  NekSessionReloadOutcome,
  NekSettingsReadResult,
} from "@zcode/shared/nek-protocol";
import type { NekModelFactsApi } from "../src/model-provider/nekModelFacts.js";

export const LOCAL: NekConfigTarget = { kind: "local" };

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function catalogModel(
  input: Partial<NekCatalogModel> & Pick<NekCatalogModel, "provider" | "id">,
): NekCatalogModel {
  return {
    provider: input.provider,
    id: input.id,
    name: input.name ?? input.id,
    api: input.api ?? "openai-completions",
    contextWindow: input.contextWindow ?? 32_000,
    maxTokens: input.maxTokens ?? 4_096,
    reasoning: input.reasoning ?? false,
    thinkingLevels: input.thinkingLevels ?? ["off"],
    input: input.input ?? ["text"],
  };
}

function settingsView(effective: Record<string, unknown> = {}): NekSettingsReadResult {
  return {
    revision: "r1",
    path: "/home/nek/.nek/agent/settings.json",
    scope: "global",
    values: {},
    effective,
    // 与真实 `readSettings` 一致：`defaults` 是 nek 默认值（含 DEFAULT_THINKING_LEVEL）。
    defaults: { defaultThinkingLevel: "medium" },
    diagnostics: [],
  };
}

function reloadOutcome(
  failures: NekSessionReloadOutcome["failures"] = [],
): NekSessionReloadOutcome {
  return { reloaded: failures.length === 0 ? 1 : 0, deferred: 0, diagnostics: [], failures };
}

interface FakeFactsApiOptions {
  available?: NekCatalogModel[];
  catalog?: NekCatalogModel[];
  auth?: NekAuthProviderStatus[];
  /** models.json 里的服务商（只用来核对显示名同源）。 */
  configuredProviders?: Array<{ id: string; name?: string }>;
  /** 全局生效设置。 */
  effective?: Record<string, unknown>;
  /** 按 cwd 生效设置（项目级合并结果）；缺省回落到 `effective`。 */
  effectiveByCwd?: Record<string, Record<string, unknown>>;
  readError?: Error;
  reloadError?: Error;
  reloadFailures?: NekSessionReloadOutcome["failures"];
}

export type FakeFactsApi = NekModelFactsApi & {
  readonly calls: Array<{
    method: string;
    target: NekConfigTarget;
    scope?: NekConfigScope;
    cwd?: string;
  }>;
  /** 推一次“配置变化”事件（会先置 reloadPending 再通知订阅者）。 */
  notifyWatch(cwd?: string, error?: string): void;
  gateNextReload(): Deferred<void>;
  readonly watchDisposed: number;
  /** 让下一次 `listAvailableModels` 等这个 deferred 完成（控制读完成时机）。 */
  gateNextRead(): Deferred<void>;
  setCatalog(available: NekCatalogModel[], catalog: NekCatalogModel[]): void;
  setEffective(effective: Record<string, unknown>): void;
  setReadError(error: Error | undefined): void;
  setReloadError(error: Error | undefined): void;
  setReloadFailures(failures: NekSessionReloadOutcome["failures"]): void;
};

export function createFakeFactsApi(options: FakeFactsApiOptions = {}): FakeFactsApi {
  const calls: FakeFactsApi["calls"] = [];
  const watchListeners = new Set<{ cwd?: string; notify: (cwd?: string, error?: string) => void }>();
  const reloadGates: Deferred<void>[] = [];
  let watchDisposed = 0;
  // 可变的编排状态：测试可以在中途“修好配置/解除错误”，模拟真实的重试路径。
  let available = options.available ?? [];
  let catalog = options.catalog ?? [];
  let readError = options.readError;
  let reloadError = options.reloadError;
  let reloadFailures = options.reloadFailures ?? [];
  let effective = options.effective;
  /** 读取闸门队列：每调用一次，为下一次 `listAvailableModels` 排一个闸门。 */
  const gates: Deferred<void>[] = [];
  const api: NekModelFactsApi = {
    listAvailableModels: async (target) => {
      calls.push({ method: "listAvailableModels", target });
      // 调用时快照：用 deferred 编排乱序完成时，读到的仍是“发起那一刻”的事实。
      const snapshot = available;
      const pending = gates.shift();
      if (pending) await pending.promise;
      if (readError) throw readError;
      return snapshot;
    },
    getModelCatalog: async (target) => {
      calls.push({ method: "getModelCatalog", target });
      const snapshot = catalog;
      if (readError) throw readError;
      return snapshot;
    },
    getAuthStatus: async (target) => {
      calls.push({ method: "getAuthStatus", target });
      if (readError) throw readError;
      return options.auth ?? [];
    },
    readModelsConfig: async (target) => {
      calls.push({ method: "readModelsConfig", target });
      if (readError) throw readError;
      // 事实只用 providers 的 id/name，其余字段这里给最小占位。
      return {
        providers: (options.configuredProviders ?? []).map((provider) => ({
          ...provider,
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:9/v1",
          models: [],
        })),
      } as Awaited<ReturnType<NekModelFactsApi["readModelsConfig"]>>;
    },
    readSettings: async (target, scope, cwd) => {
      calls.push({ method: "readSettings", target, scope, cwd });
      if (readError) throw readError;
      const view = cwd ? (options.effectiveByCwd?.[cwd] ?? effective) : effective;
      return settingsView(view);
    },
    reloadRunningSessions: async (target, cwd) => {
      calls.push({ method: "reloadRunningSessions", target, cwd });
      const gate = reloadGates.shift();
      if (gate) await gate.promise;
      if (reloadError) throw reloadError;
      return reloadOutcome(reloadFailures);
    },
    watch: (target, listener, cwd) => {
      calls.push({ method: "watch", target, cwd });
      const entry = { cwd, notify: (changedCwd?: string, error?: string) => listener({
        file: changedCwd ? `${changedCwd}/.nek/settings.json` : "models.json",
        revision: "r2", scope: changedCwd ? "project" : "global",
        ...(error ? { error: { message: error } } : {}),
      }) };
      watchListeners.add(entry);
      return () => {
        watchDisposed += 1;
        watchListeners.delete(entry);
      };
    },
  };
  return {
    ...api,
    calls,
    notifyWatch: (cwd, error) => {
      for (const entry of watchListeners) {
        if (!cwd || entry.cwd === cwd) entry.notify(cwd, error);
      }
    },
    gateNextReload: () => {
      const gate = deferred<void>();
      reloadGates.push(gate);
      return gate;
    },
    get watchDisposed() {
      return watchDisposed;
    },
    gateNextRead: () => {
      const gate = deferred<void>();
      gates.push(gate);
      return gate;
    },
    setCatalog: (nextAvailable, nextCatalog) => {
      available = nextAvailable;
      catalog = nextCatalog;
    },
    setEffective: (next) => {
      effective = next;
    },
    setReadError: (error) => {
      readError = error;
    },
    setReloadError: (error) => {
      reloadError = error;
    },
    setReloadFailures: (failures) => {
      reloadFailures = failures;
    },
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition not reached");
    await new Promise((done) => setTimeout(done, 5));
  }
}

export function countCalls(api: FakeFactsApi, method: string): number {
  return api.calls.filter((call) => call.method === method).length;
}
