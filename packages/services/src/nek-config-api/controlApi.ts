/**
 * 走控制进程的能力：模型目录、拉取/测试模型、联网搜索测试、账号、项目信任、配置校验。
 *
 * 这些命令的事实来源是 nek（`NEK_CONTROL_COMMANDS`），GUI 不重复实现 provider 协议、
 * OAuth 与 schema 校验，只做请求与形状映射。nek 不可用时抛 `nek_unavailable`。
 */
import type {
  NekAuthProviderStatus,
  NekBuiltinTool,
  NekCatalogModel,
  NekConfigDiagnostic,
  NekConfigTarget,
  NekFetchModelsResult,
  NekLoginEvent,
  NekLoginSession,
  NekProjectTrust,
  NekProviderDraft,
  NekProviderOverrides,
  NekTestProviderResult,
  NekTestWebSearchResult,
} from "@zcode/shared/nek-protocol";
import { NEK_THINKING_LEVELS } from "@zcode/shared/nek-protocol";
import type { NekModel } from "@zcode/shared/nek-protocol";
import type { NekConfigRuntime } from "./runtime.js";
import { validationError } from "./errors.js";
import { assertWebSearchProbeSupported, resolveWebSearchCapabilities } from "./settingsApi.js";
import { readSettingsDocument } from "./settingsDocument.js";
import { settingsPath } from "./paths.js";

export type ProviderSource = { providerId: string; draft?: NekProviderDraft };

export interface NekControlGroup {
  getModelCatalog: (target: NekConfigTarget, ids?: string[]) => Promise<NekCatalogModel[]>;
  listAvailableModels: (target: NekConfigTarget) => Promise<NekCatalogModel[]>;
  listBuiltinTools: (target: NekConfigTarget) => Promise<NekBuiltinTool[]>;
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

/**
 * 请求来源 → nek 命令参数。
 *
 * 两种来源共用 `providerId`：没有 `draft` 时直接用已保存的 provider；有 `draft` 时把草稿里
 * 写了的字段作为 `overrides` 交给 nek，由 nek 叠加在已保存的 provider 之上——没写的字段
 * （密钥、请求头、`authHeader`）沿用保存值，所以"改了 baseUrl 但没重新输入密钥"照样能测。
 * nek 的 `overrides` 支持 `$ENV` / `!command`，与 models.json 的解析规则一致。
 */
function providerCommand(source: ProviderSource): {
  provider: string;
  overrides?: NekProviderOverrides;
} {
  if (source.providerId.trim() === "") {
    throw validationError("providerId is required", { providerId: "required" });
  }
  if (!source.draft) return { provider: source.providerId };
  return { provider: source.providerId, overrides: overridesOf(source.draft) };
}

/** 草稿的字段全部可选地映射成 `overrides`；缺省的字段表示沿用已保存的值。 */
function overridesOf(draft: NekProviderDraft): NekProviderOverrides {
  return {
    api: draft.api,
    baseUrl: draft.baseUrl,
    ...(draft.apiKey === undefined ? {} : { apiKey: draft.apiKey }),
    ...(draft.headers === undefined ? {} : { headers: draft.headers }),
    ...(draft.authHeader === undefined ? {} : { authHeader: draft.authHeader }),
  };
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

    listBuiltinTools: async (target) => {
      const control = await runtime.control(target);
      const data = await control.call({ type: "list_builtin_tools" });
      return data.tools;
    },

    fetchProviderModels: async (target, source) => {
      const control = await runtime.control(target);
      return await control.call({ type: "fetch_provider_models", ...providerCommand(source) });
    },

    testProvider: async (target, source, modelId) => {
      const control = await runtime.control(target);
      return await control.call({ type: "test_provider", modelId, ...providerCommand(source) });
    },

    testWebSearch: async (target, query) => {
      // 探测由目标上的 nek 自己读配置执行：旧 nek 会把显式 Tavily 静默当成 Exa 并发出
      // Tavily key。先按目标现有配置与版本做一次前置检查，不合规就在起控制进程之前失败，
      // 既不发探测请求，也不去解析密钥值。
      const context = runtime.target(target);
      const settings = await readSettingsDocument(
        context.executor,
        settingsPath(context.layout, "global"),
      );
      assertWebSearchProbeSupported(
        settings.raw,
        await resolveWebSearchCapabilities(runtime, target),
      );
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
