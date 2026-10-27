/**
 * 走控制进程的能力：模型目录、拉取/测试模型、联网搜索测试、账号、项目信任、配置校验。
 *
 * 这些命令的事实来源是 nek（`NEK_CONTROL_COMMANDS`），GUI 不重复实现 provider 协议、
 * OAuth 与 schema 校验，只做请求与形状映射。nek 不可用时抛 `nek_unavailable`。
 */
import type {
  NekAuthProviderStatus,
  NekCatalogModel,
  NekConfigDiagnostic,
  NekConfigTarget,
  NekFetchModelsResult,
  NekLoginEvent,
  NekLoginSession,
  NekProjectTrust,
  NekProviderDraft,
  NekTestProviderResult,
  NekTestWebSearchResult,
} from "@zcode/shared/nek-protocol";
import { NEK_THINKING_LEVELS } from "@zcode/shared/nek-protocol";
import type { NekModel } from "@zcode/shared/nek-protocol";
import type { NekConfigRuntime } from "./runtime.js";

export type ProviderSource = { providerId: string } | { draft: NekProviderDraft };

export interface NekControlGroup {
  getModelCatalog: (target: NekConfigTarget, ids?: string[]) => Promise<NekCatalogModel[]>;
  listAvailableModels: (target: NekConfigTarget) => Promise<NekCatalogModel[]>;
  fetchProviderModels: (
    target: NekConfigTarget,
    source: ProviderSource,
  ) => Promise<NekFetchModelsResult>;
  testProvider: (
    target: NekConfigTarget,
    source: ProviderSource,
    modelId: string,
  ) => Promise<NekTestProviderResult>;
  testWebSearch: (target: NekConfigTarget, query: string) => Promise<NekTestWebSearchResult>;
  getAuthStatus: (target: NekConfigTarget) => Promise<NekAuthProviderStatus[]>;
  startLogin: (target: NekConfigTarget, provider: string) => Promise<NekLoginSession>;
  answerLoginPrompt: (loginId: string, promptId: string, value: string) => Promise<void>;
  cancelLogin: (loginId: string) => Promise<void>;
  onLoginEvent: (loginId: string, listener: (event: NekLoginEvent) => void) => () => void;
  logout: (target: NekConfigTarget, provider: string) => Promise<void>;
  getProjectTrust: (target: NekConfigTarget, cwd: string) => Promise<NekProjectTrust>;
  setProjectTrust: (target: NekConfigTarget, cwd: string, trusted: boolean) => Promise<void>;
  validate: (target: NekConfigTarget, cwd?: string) => Promise<NekConfigDiagnostic[]>;
}

function thinkingLevelsOf(model: NekModel): NekCatalogModel["thinkingLevels"] {
  if (model.reasoning !== true) return [];
  return NEK_THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
}

/** nek 的 `NekModel` → 设置页用的目录条目（缺省值与 nek 的模型默认值一致）。 */
export function toCatalogModel(model: NekModel): NekCatalogModel {
  const cost = model.cost;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
    api: model.api,
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 16_384,
    reasoning: model.reasoning === true,
    thinkingLevels: thinkingLevelsOf(model),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: model.input ?? ["text"],
    ...(cost
      ? {
          cost: {
            input: cost.input,
            output: cost.output,
            cacheRead: cost.cacheRead,
            cacheWrite: cost.cacheWrite,
          },
        }
      : {}),
  };
}

function sourceCommand(
  source: ProviderSource,
): { providerId: string } | { draft: NekProviderDraft } {
  return "draft" in source ? { draft: source.draft } : { providerId: source.providerId };
}

export function createControlGroup(runtime: NekConfigRuntime): NekControlGroup {
  return {
    getModelCatalog: async (target, ids) => {
      const control = await runtime.control(target);
      const data = await control.call({
        type: "get_model_catalog",
        ...(ids && ids.length > 0 ? { ids } : {}),
      });
      // `get_model_catalog` 已经是契约形状，不需要再映射。
      return data.models ?? [];
    },

    listAvailableModels: async (target) => {
      const control = await runtime.control(target);
      const data = await control.call({ type: "get_available_models" });
      return (data.models ?? []).map(toCatalogModel);
    },

    fetchProviderModels: async (target, source) => {
      const control = await runtime.control(target);
      const resolved = sourceCommand(source);
      const command =
        "draft" in resolved
          ? { type: "fetch_provider_models" as const, draft: resolved.draft }
          : { type: "fetch_provider_models" as const, provider: resolved.providerId };
      return await control.call(command);
    },

    testProvider: async (target, source, modelId) => {
      const control = await runtime.control(target);
      const resolved = sourceCommand(source);
      const command =
        "draft" in resolved
          ? { type: "test_provider" as const, modelId, draft: resolved.draft }
          : { type: "test_provider" as const, modelId, provider: resolved.providerId };
      return await control.call(command);
    },

    testWebSearch: async (target, query) => {
      const control = await runtime.control(target);
      return await control.call({ type: "test_web_search", query });
    },

    getAuthStatus: async (target) => await runtime.login.authStatus(target),

    startLogin: async (target, provider) => await runtime.login.start(target, provider),

    answerLoginPrompt: async (loginId, promptId, value) => {
      await runtime.login.answer(loginId, promptId, value);
    },

    cancelLogin: async (loginId) => {
      await runtime.login.cancel(loginId);
    },

    onLoginEvent: (loginId, listener) => runtime.login.subscribe(loginId, listener),

    logout: async (target, provider) => {
      await runtime.login.logout(target, provider);
    },

    getProjectTrust: async (target, cwd) => {
      const control = await runtime.control(target);
      return await control.call({ type: "get_project_trust", cwd });
    },

    setProjectTrust: async (target, cwd, trusted) => {
      const control = await runtime.control(target);
      await control.call({ type: "set_project_trust", cwd, trusted });
    },

    validate: async (target, cwd) => {
      const control = await runtime.control(target);
      const data = await control.call(
        cwd ? { type: "validate_config", cwd } : { type: "validate_config" },
      );
      return data.diagnostics ?? [];
    },
  };
}
