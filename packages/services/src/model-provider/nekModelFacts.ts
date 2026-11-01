/**
 * 模型选择事实：nek 侧的“现在能跑哪些模型”。
 *
 * 只经既有实现读取，不新写 parser、不建镜像：
 * - `listAvailableModels`（nek `get_available_models`）决定可用性：OAuth 已登录的内建服务商与
 *   models.json 的自定义服务商都由 nek 自己判定；
 * - `getModelCatalog`（nek `get_model_catalog`）提供模型详情与 nek 自己的思考等级；
 * - `readModelsConfig` 提供 models.json 里的服务商显示名（与设置页同一字段）；
 * - `getAuthStatus`（nek `auth_status`）只给没有 models.json 条目的内建服务商补显示名；
 * - `readSettings` 提供默认模型/思考等级；有 workspace 时读 `project` 作用域的 `effective`，
 *   与 nek 的 `SettingsManager`（global ← project 深合并）一致；
 * - `watch` + `reloadRunningSessions`：配置变化 → nek 先重读配置，再读事实。
 *
 * 目标固定为本机：host 进程本身就运行在目标机器上（远端 workspace 由远端 gui-server 的
 * 同名服务回答），因此这里不猜、也不接受“本地表代替远端”的目标参数。
 */
import type {
  NekAuthProviderStatus,
  NekCatalogModel,
  NekConfigScope,
  NekConfigTarget,
  NekModelsConfigView,
  NekSessionReloadOutcome,
  NekSettingsReadResult,
} from "@zcode/shared/nek-protocol";
import { clampNekThinkingLevel } from "./nekThinkingLevel.js";

/** 事实读取只需要 `INekConfigApi` 的这些方法；生产环境注入真实实现。 */
export interface NekModelFactsApi {
  listAvailableModels(target: NekConfigTarget): Promise<NekCatalogModel[]>;
  getModelCatalog(target: NekConfigTarget, ids?: string[]): Promise<NekCatalogModel[]>;
  getAuthStatus(target: NekConfigTarget): Promise<NekAuthProviderStatus[]>;
  readModelsConfig(target: NekConfigTarget): Promise<Pick<NekModelsConfigView, "providers">>;
  readSettings(
    target: NekConfigTarget,
    scope: NekConfigScope,
    cwd?: string,
  ): Promise<NekSettingsReadResult>;
  /** 配置变了以后，让目标机器上的 nek 进程重读（设置页写路径用的是同一入口）。 */
  reloadRunningSessions(target: NekConfigTarget, cwd?: string): Promise<NekSessionReloadOutcome>;
  watch(
    target: NekConfigTarget,
    listener: (change: { file: string; revision: string; scope: NekConfigScope; error?: { message: string } }) => void,
    cwd?: string,
  ): () => void;
}

const NEK_LOCAL_TARGET: NekConfigTarget = { kind: "local" };

export interface NekModelFactsProvider {
  readonly providerId: string;
  readonly displayName: string;
}

export interface NekModelFactsModel {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayName: string;
  /** nek `getSupportedThinkingLevels` 的结果（低→高）。 */
  readonly reasoningLevels: readonly string[];
  /** nek 的默认等级（模型覆盖 → 全局默认）按 `clampThinkingLevel` 夹到受支持等级。 */
  readonly defaultReasoningLevel?: string;
  readonly supportsImage: boolean;
}

/** 全新草稿的默认偏好；值是 nek 配置原文，是否可用由目录决定。 */
export interface NekModelFactsDefaults {
  readonly providerId?: string;
  readonly modelId?: string;
}

export interface NekModelFacts {
  readonly providers: readonly NekModelFactsProvider[];
  readonly models: readonly NekModelFactsModel[];
  readonly defaults: NekModelFactsDefaults;
}

export interface NekModelFactsReadOptions {
  /** 目标机器上的 workspace 根目录；提供时按项目级配置合并默认值。 */
  readonly cwd?: string;
}

export interface NekModelFactsSource {
  /** 总是读最新事实；失败直接抛出 nek 的结构化错误。 */
  read(options?: NekModelFactsReadOptions): Promise<NekModelFacts>;
  /** 事实可能过期的信号（配置变化）；不携带快照，调用方重新 `read()`。 */
  onDidChange(listener: () => void, options?: NekModelFactsReadOptions): () => void;
  dispose(): void;
}

function availableKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`;
}

/**
 * 重载失败：控制进程没读到新配置，事实不可信。
 *
 * 显式而不是“记日志继续”：控制进程的 `get_available_models` / `get_model_catalog` 回答的是它
 * 启动时加载的 models.json，重载失败时继续读会把旧目录当成当前事实。
 */
export class NekModelFactsReloadError extends Error {
  constructor(
    readonly detail: string,
    readonly outcome?: NekSessionReloadOutcome,
  ) {
    super(`nek 配置重载失败：${detail}`);
    this.name = "NekModelFactsReloadError";
  }
}

/** Scope leases own watch errors; one shared epoch/flight owns control reload admission. */
export function createNekModelFactsSource(
  api: NekModelFactsApi,
  options: {
    readonly target?: NekConfigTarget;
    readonly log?: { warn: (traceId: undefined, ...args: unknown[]) => void };
  } = {},
): NekModelFactsSource {
  const target = options.target ?? NEK_LOCAL_TARGET;
  const scopes = new Map<string, {
    listeners: Set<() => void>;
    errors: Map<string, string>;
    stop(): void;
  }>();
  let disposed = false;
  let epoch = 0;
  let loadedEpoch = 0;
  let reloading: Promise<void> | undefined;

  const reload = async (): Promise<void> => {
    const generation = epoch;
    let outcome: NekSessionReloadOutcome;
    try {
      outcome = await api.reloadRunningSessions(target);
    } catch (error) {
      throw new NekModelFactsReloadError(error instanceof Error ? error.message : String(error));
    }
    const failures = outcome.failures.filter((failure) => failure.sessionKey === "control" || failure.sessionKey === "runtime");
    if (failures.length > 0) {
      throw new NekModelFactsReloadError(failures.map((failure) => failure.message).join("; "), outcome);
    }
    loadedEpoch = generation;
    if (outcome.failures.length > 0) options.log?.warn(undefined, "[model-selection] nek 会话重载未全部成功", { failures: outcome.failures });
  };

  const assertHealthy = (cwd: string): void => {
    if (disposed) throw new Error("NekModelFactsSource 已 dispose");
    for (const key of new Set(["", cwd])) {
      const errors = scopes.get(key)?.errors;
      if (errors?.size) throw new Error(`nek config watch: ${[...errors.values()].join("; ")}`);
    }
  };

  return {
    read: async (readOptions) => {
      const cwd = readOptions?.cwd?.trim() ?? "";
      assertHealthy(cwd);
      for (let attempt = 0; loadedEpoch !== epoch; attempt += 1) {
        if (attempt === 3) throw new NekModelFactsReloadError("Configuration kept changing; retry the read");
        if (!reloading) reloading = reload().finally(() => { reloading = undefined; });
        await reloading;
        assertHealthy(cwd);
      }
      const [available, catalog, authStatus, modelsConfig, settings] = await Promise.all([
        api.listAvailableModels(target),
        api.getModelCatalog(target),
        api.getAuthStatus(target),
        api.readModelsConfig(target),
        cwd ? api.readSettings(target, "project", cwd) : api.readSettings(target, "global"),
      ]);
      assertHealthy(cwd);
      if (settings.diagnostics.length > 0) throw new Error(settings.diagnostics.map((item) => item.message).join("; "));
      return composeFacts({ available, catalog, authStatus, modelsConfig, settings });
    },
    onDidChange: (listener, readOptions) => {
      if (disposed) throw new Error("NekModelFactsSource 已 dispose");
      const cwd = readOptions?.cwd?.trim() ?? "";
      if (!scopes.has(cwd) && scopes.size >= 128) throw new Error("Model observation capacity exceeded");
      let state = scopes.get(cwd);
      if (!state) {
        state = { listeners: new Set(), errors: new Map(), stop: () => undefined };
        const owned = state;
        scopes.set(cwd, state);
        let stop: () => void;
        try {
          stop = api.watch(target, (change) => {
          if (disposed || scopes.get(cwd) !== owned) return;
          // Global delivery is owned by the global lease, not duplicated by every project lease.
          if (cwd && change.scope === "global") return;
          if (change.error) owned.errors.set(change.file, change.error.message);
          else owned.errors.delete(change.file);
          if (!cwd) epoch += 1;
          for (const [key, scope] of scopes) {
            if (cwd && key !== cwd) continue;
            for (const notify of [...scope.listeners]) notify();
          }
          }, cwd || undefined);
        } catch (error) {
          scopes.delete(cwd);
          throw error;
        }
        state.stop = stop;
      }
      const owned = state;
      const notify = () => listener();
      owned.listeners.add(notify);
      return () => {
        owned.listeners.delete(notify);
        if (owned.listeners.size > 0 || scopes.get(cwd) !== owned) return;
        owned.stop();
        scopes.delete(cwd);
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const state of scopes.values()) state.stop();
      scopes.clear();
    },
  };
}

/**
 * 纯合并：可用性 ∩ 目录，服务商顺序按目录首现。
 *
 * 显示名与设置页同源：models.json 有条目就用它的 `name`（缺省为 id），否则用 nek 的
 * `auth_status` 显示名（OAuth 登录的内建服务商），再退 providerId。
 */
function composeFacts(input: {
  readonly available: readonly NekCatalogModel[];
  readonly catalog: readonly NekCatalogModel[];
  readonly authStatus: readonly NekAuthProviderStatus[];
  readonly modelsConfig: Pick<NekModelsConfigView, "providers">;
  readonly settings: Pick<NekSettingsReadResult, "effective" | "defaults">;
}): NekModelFacts {
  const availableKeys = new Set(
    input.available.map((model) => availableKey(model.provider, model.id)),
  );
  const configuredNames = new Map(
    input.modelsConfig.providers.map(
      (provider) => [provider.id, provider.name?.trim() || provider.id] as const,
    ),
  );
  const authNames = new Map(
    input.authStatus.map((status) => [status.provider, status.name] as const),
  );
  const effective = input.settings.effective;
  // `readSettings` 的 `effective` 已把 nek 默认值合并进来；万一某层缺省，用契约自己的
  // `defaults`（镜像 nek `core/defaults.ts` 的 DEFAULT_THINKING_LEVEL）兜住默认档位。
  const defaultReasoningLevel =
    effective.defaultThinkingLevel ?? input.settings.defaults.defaultThinkingLevel;
  const modelReasoningLevels = effective.modelThinkingLevels ?? {};
  const providers: NekModelFactsProvider[] = [];
  const models: NekModelFactsModel[] = [];
  for (const model of input.catalog) {
    if (!availableKeys.has(availableKey(model.provider, model.id))) continue;
    if (!providers.some((provider) => provider.providerId === model.provider)) {
      providers.push({
        providerId: model.provider,
        displayName:
          configuredNames.get(model.provider) ??
          authNames.get(model.provider)?.trim() ??
          model.provider,
      });
    }
    const requestedReasoningLevel =
      modelReasoningLevels[`${model.provider}/${model.id}`] ?? defaultReasoningLevel;
    const clampedReasoningLevel = requestedReasoningLevel
      ? clampNekThinkingLevel(model.thinkingLevels, requestedReasoningLevel)
      : undefined;
    models.push({
      providerId: model.provider,
      modelId: model.id,
      displayName: model.name?.trim() || model.id,
      reasoningLevels: model.thinkingLevels,
      ...(clampedReasoningLevel ? { defaultReasoningLevel: clampedReasoningLevel } : {}),
      supportsImage: model.input.includes("image"),
    });
  }
  return {
    providers,
    models,
    defaults: {
      ...(effective.defaultProvider !== undefined ? { providerId: effective.defaultProvider } : {}),
      ...(effective.defaultModel !== undefined ? { modelId: effective.defaultModel } : {}),
    },
  };
}
