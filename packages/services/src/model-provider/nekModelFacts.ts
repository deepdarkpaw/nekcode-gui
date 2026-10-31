/**
 * 模型选择事实：nek 侧的“现在能跑哪些模型”。
 *
 * 只经既有实现读取，不新写 parser、不建镜像：
 * - `listAvailableModels`（nek `get_available_models`）决定可用性：OAuth 已登录的内建服务商与
 *   models.json 的自定义服务商都由 nek 自己判定；
 * - `getModelCatalog`（nek `get_model_catalog`）提供模型详情与 nek 自己的思考等级；
 * - `readModelsConfig` 提供 models.json 里的服务商显示名（与设置页同一字段）；
 * - `getAuthStatus`（nek `auth_status`）只给没有 models.json 条目的内建服务商补显示名；
 * - `readSettings` 提供 `settings.json` 的默认模型/档位偏好；
 * - `watch` 把配置变化变成一次重新读取。
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
  NekSettingsReadResult,
} from "@zcode/shared/nek-protocol";

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
  watch(
    target: NekConfigTarget,
    listener: (change: { file: string; revision: string; scope: NekConfigScope }) => void,
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
  readonly supportsImage: boolean;
}

/** 全新草稿的默认偏好；值是 nek 配置原文，是否可用由目录决定。 */
export interface NekModelFactsDefaults {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly reasoningLevel?: string;
  /** `provider/modelId` → 模型级思考等级（nek `modelThinkingLevels`）。 */
  readonly modelReasoningLevels: Readonly<Record<string, string>>;
}

export interface NekModelFacts {
  readonly providers: readonly NekModelFactsProvider[];
  readonly models: readonly NekModelFactsModel[];
  readonly defaults: NekModelFactsDefaults;
}

export interface NekModelFactsSource {
  /** 每次都读最新事实；失败直接抛出 nek 的结构化错误。 */
  read(): Promise<NekModelFacts>;
  onDidChange(listener: () => void): () => void;
  dispose(): void;
}

function availableKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`;
}

/**
 * 事实来源：可用性（`get_available_models`）与详情（`get_model_catalog`）取交集。
 *
 * 两者分工固定：可用性回答“能不能跑”，目录回答“叫什么、支持哪些档位”。
 * 因此 models.json 有条目但没有可用凭据时不会出现在候选里——那是 nek 自己的判定。
 */
export function createNekModelFactsSource(
  api: NekModelFactsApi,
  options: { readonly target?: NekConfigTarget } = {},
): NekModelFactsSource {
  const target = options.target ?? NEK_LOCAL_TARGET;
  const listeners = new Set<() => void>();
  let disposed = false;
  let unsubscribeWatch: (() => void) | undefined;

  const read = async (): Promise<NekModelFacts> => {
    const [available, catalog, authStatus, modelsConfig, settings] = await Promise.all([
      api.listAvailableModels(target),
      api.getModelCatalog(target),
      api.getAuthStatus(target),
      api.readModelsConfig(target),
      api.readSettings(target, "global"),
    ]);
    if (disposed) throw new Error("NekModelFactsSource 已 dispose");
    return composeFacts({ available, catalog, authStatus, modelsConfig, settings });
  };

  return {
    read,
    onDidChange: (listener) => {
      if (disposed) return () => undefined;
      if (!unsubscribeWatch) {
        unsubscribeWatch = api.watch(target, () => {
          if (disposed) return;
          for (const notify of listeners) notify();
        });
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeWatch?.();
          unsubscribeWatch = undefined;
        }
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribeWatch?.();
      unsubscribeWatch = undefined;
      listeners.clear();
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
  readonly settings: Pick<NekSettingsReadResult, "effective">;
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
    models.push({
      providerId: model.provider,
      modelId: model.id,
      displayName: model.name?.trim() || model.id,
      reasoningLevels: model.thinkingLevels,
      supportsImage: model.input.includes("image"),
    });
  }
  const effective = input.settings.effective;
  return {
    providers,
    models,
    defaults: {
      ...(effective.defaultProvider ? { providerId: effective.defaultProvider } : {}),
      ...(effective.defaultModel ? { modelId: effective.defaultModel } : {}),
      ...(effective.defaultThinkingLevel ? { reasoningLevel: effective.defaultThinkingLevel } : {}),
      modelReasoningLevels: effective.modelThinkingLevels ?? {},
    },
  };
}
