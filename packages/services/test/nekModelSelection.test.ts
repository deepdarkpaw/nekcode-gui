/**
 * `IModelSelectionService` 的 nek 事实来源契约：
 * - 候选与默认值只来自 nek 的可用性 + 目录 + settings；
 * - 坏配置直接抛错（不伪装成空表）；
 * - 变更只经 watch 推给订阅者，退订与 dispose 都回收；
 * - 目标固定为本机（远端由远端自己的 host 回答）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  NekAuthProviderStatus,
  NekCatalogModel,
  NekConfigScope,
  NekConfigTarget,
  NekSettingsReadResult,
} from "@zcode/shared/nek-protocol";
import {
  createNekModelFactsSource,
  type NekModelFactsApi,
} from "../src/model-provider/nekModelFacts.js";
import { createNekModelSelectionService } from "../src/model-provider/nekModelSelectionService.js";

const LOCAL: NekConfigTarget = { kind: "local" };

function catalogModel(
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
    defaults: {},
    diagnostics: [],
  };
}

interface FakeApiOptions {
  available?: NekCatalogModel[];
  catalog?: NekCatalogModel[];
  auth?: NekAuthProviderStatus[];
  /** models.json 里的服务商（只用来核对显示名同源）。 */
  configuredProviders?: Array<{ id: string; name?: string }>;
  effective?: Record<string, unknown>;
  readError?: Error;
}

/** 只记录调用并返回编排好的事实：不接触真实 nek、不读真实文件。 */
function createFakeApi(options: FakeApiOptions = {}) {
  const calls: Array<{ method: string; target: NekConfigTarget; scope?: NekConfigScope }> = [];
  let watchListener: (() => void) | undefined;
  let watchDisposed = 0;
  const api: NekModelFactsApi = {
    listAvailableModels: async (target) => {
      calls.push({ method: "listAvailableModels", target });
      if (options.readError) throw options.readError;
      return options.available ?? [];
    },
    getModelCatalog: async (target) => {
      calls.push({ method: "getModelCatalog", target });
      if (options.readError) throw options.readError;
      return options.catalog ?? [];
    },
    getAuthStatus: async (target) => {
      calls.push({ method: "getAuthStatus", target });
      if (options.readError) throw options.readError;
      return options.auth ?? [];
    },
    readModelsConfig: async (target) => {
      calls.push({ method: "readModelsConfig", target });
      if (options.readError) throw options.readError;
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
    readSettings: async (target, scope) => {
      calls.push({ method: "readSettings", target, scope });
      if (options.readError) throw options.readError;
      return settingsView(options.effective);
    },
    watch: (target, listener) => {
      calls.push({ method: "watch", target });
      watchListener = () => listener({ file: "models.json", revision: "r2", scope: "global" });
      return () => {
        watchDisposed += 1;
        watchListener = undefined;
      };
    },
  };
  return {
    api,
    calls,
    notifyWatch: () => watchListener?.(),
    get watchDisposed() {
      return watchDisposed;
    },
  };
}

function serviceOf(api: NekModelFactsApi) {
  return createNekModelSelectionService({ facts: createNekModelFactsSource(api) });
}

const CUSTOM_MODEL = catalogModel({ provider: "mock", id: "mock-model", name: "Local Mock Model" });
const CUSTOM_MODEL_2 = catalogModel({ provider: "mock", id: "mock-model-2" });
const OAUTH_MODEL = catalogModel({
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  reasoning: true,
  thinkingLevels: ["off", "low", "medium", "high"],
});

test("空配置：providers 为空且没有默认选择", async () => {
  const { api } = createFakeApi();
  const service = serviceOf(api);
  const view = await service.getView();
  assert.deepEqual(view.providers, []);
  assert.equal(view.preferredSelection, undefined);
  assert.ok(view.revision >= 1);
  service.dispose();
});

test("自定义 provider 与 OAuth 已登录的内建 provider 同时出现", async () => {
  const { api } = createFakeApi({
    available: [CUSTOM_MODEL, OAUTH_MODEL],
    catalog: [CUSTOM_MODEL, CUSTOM_MODEL_2, OAUTH_MODEL],
    auth: [
      { provider: "mock", name: "Mock Provider", kind: "api_key", state: "ok", loginMethods: [] },
      {
        provider: "anthropic",
        name: "Anthropic (Claude Pro/Max)",
        kind: "oauth",
        state: "ok",
        loginMethods: ["oauth"],
      },
    ],
  });
  const service = serviceOf(api);
  const view = await service.getView();
  assert.deepEqual(
    view.providers.map((provider) => provider.providerId),
    ["mock", "anthropic"],
  );
  assert.deepEqual(
    view.providers.map((provider) => provider.displayName),
    ["Mock Provider", "Anthropic (Claude Pro/Max)"],
  );
  // 非推理模型的档位是 nek 自己的 ["off"]；不在可用集里的模型不出现。
  assert.deepEqual(
    view.providers[0]?.models.map((model) => [model.modelId, model.reasoningLevels]),
    [["mock-model", ["off"]]],
  );
  assert.deepEqual(view.providers[1]?.models[0]?.reasoningLevels, ["off", "low", "medium", "high"]);
  service.dispose();
});

test("服务商显示名与设置页同源：models.json 名称优先，其次 nek 账号显示名", async () => {
  const { api } = createFakeApi({
    available: [CUSTOM_MODEL, OAUTH_MODEL],
    catalog: [CUSTOM_MODEL, OAUTH_MODEL],
    configuredProviders: [{ id: "mock", name: "公司网关" }],
    auth: [
      // nek 对自定义 provider 的 api_key 显示名是通用标签，不能拿来当服务商名。
      { provider: "mock", name: "API key", kind: "api_key", state: "ok", loginMethods: [] },
      {
        provider: "anthropic",
        name: "Anthropic (Claude Pro/Max)",
        kind: "oauth",
        state: "ok",
        loginMethods: ["oauth"],
      },
    ],
  });
  const service = serviceOf(api);
  const view = await service.getView();
  assert.deepEqual(
    view.providers.map((provider) => [provider.providerId, provider.displayName]),
    [
      ["mock", "公司网关"],
      ["anthropic", "Anthropic (Claude Pro/Max)"],
    ],
  );
  service.dispose();
});

test("models.json 有条目但 nek 判定不可用时不进候选", async () => {
  const { api } = createFakeApi({ available: [], catalog: [CUSTOM_MODEL, CUSTOM_MODEL_2] });
  const service = serviceOf(api);
  const view = await service.getView();
  assert.deepEqual(view.providers, []);
  service.dispose();
});

test("settings 默认模型进入 preferredSelection，档位取 modelThinkingLevels 优先", async () => {
  const { api } = createFakeApi({
    available: [CUSTOM_MODEL, OAUTH_MODEL],
    catalog: [CUSTOM_MODEL, OAUTH_MODEL],
    effective: {
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
      defaultThinkingLevel: "low",
      modelThinkingLevels: { "anthropic/claude-sonnet-4-5": "high" },
    },
  });
  const service = serviceOf(api);
  const view = await service.getView();
  assert.deepEqual(view.preferredSelection, {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    options: { reasoningLevel: "high" },
  });
  service.dispose();
});

test("默认模型不可用时退回目录首条，且不改写保存的默认值", async () => {
  const { api } = createFakeApi({
    available: [CUSTOM_MODEL],
    catalog: [CUSTOM_MODEL],
    effective: { defaultProvider: "gone", defaultModel: "gone-model" },
  });
  const service = serviceOf(api);
  const view = await service.getView();
  assert.deepEqual(view.preferredSelection, {
    providerId: "mock",
    modelId: "mock-model",
    options: { reasoningLevel: "off" },
  });
  service.dispose();
});

test("getView(input) 解析当前选择：存在 / provider 缺失 / model 缺失 / 档位不受支持", async () => {
  const { api } = createFakeApi({
    available: [OAUTH_MODEL],
    catalog: [OAUTH_MODEL],
    effective: { defaultThinkingLevel: "medium" },
  });
  const service = serviceOf(api);
  const ok = await service.getView({
    selection: {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
      options: { reasoningLevel: "medium" },
    },
  });
  assert.deepEqual(ok.effectiveSelection, {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
    options: { reasoningLevel: "medium" },
  });
  assert.equal(ok.selectionIssue, undefined);

  const missingProvider = await service.getView({
    selection: { providerId: "nope", modelId: "x", options: { reasoningLevel: "off" } },
  });
  assert.equal(missingProvider.selectionIssue, "provider-not-found");
  assert.equal(missingProvider.effectiveSelection, null);

  const missingModel = await service.getView({
    selection: {
      providerId: "anthropic",
      modelId: "nope",
      options: { reasoningLevel: "off" },
    },
  });
  assert.equal(missingModel.selectionIssue, "model-not-found");

  const badLevel = await service.getView({
    selection: {
      providerId: "anthropic",
      modelId: "claude-sonnet-4-5",
      options: { reasoningLevel: "max" },
    },
  });
  assert.equal(badLevel.selectionIssue, "reasoning-level-not-supported");
  assert.deepEqual(badLevel.effectiveSelection, {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
  });
  service.dispose();
});

test("坏配置/权限错误直接抛出，不伪装成空表", async () => {
  const failure = new Error("models.json 解析失败");
  const { api } = createFakeApi({ readError: failure });
  const service = serviceOf(api);
  await assert.rejects(
    () => service.getView(),
    (error: unknown) => error === failure,
  );
  service.dispose();
});

test("watch 通知变更并推进 revision；内容未变时不产生伪变更", async () => {
  const fake = createFakeApi({ available: [CUSTOM_MODEL], catalog: [CUSTOM_MODEL] });
  const service = serviceOf(fake.api);
  const views: Array<{ revision: number; modelCount: number }> = [];
  service.onDidChange((view) =>
    views.push({
      revision: view.revision,
      modelCount: view.providers.reduce((total, provider) => total + provider.models.length, 0),
    }),
  );
  const first = await service.getView();

  fake.notifyWatch();
  await new Promise((done) => setImmediate(done));
  assert.equal(views.length, 0, "内容未变不应通知");

  fake.api.listAvailableModels = async () => [CUSTOM_MODEL, CUSTOM_MODEL_2];
  fake.api.getModelCatalog = async () => [CUSTOM_MODEL, CUSTOM_MODEL_2];
  fake.notifyWatch();
  await waitFor(() => views.length === 1);
  assert.deepEqual(views[0], { revision: first.revision + 1, modelCount: 2 });
  service.dispose();
});

test("同一事实重复读取不推进 revision；新事实推进一次", async () => {
  const fake = createFakeApi({ available: [CUSTOM_MODEL], catalog: [CUSTOM_MODEL] });
  const service = serviceOf(fake.api);
  const a = await service.getView();
  const b = await service.getView();
  assert.equal(a.revision, b.revision);
  fake.api.listAvailableModels = async () => [CUSTOM_MODEL, CUSTOM_MODEL_2];
  fake.api.getModelCatalog = async () => [CUSTOM_MODEL, CUSTOM_MODEL_2];
  const c = await service.getView();
  assert.equal(c.revision, a.revision + 1);
  service.dispose();
});

test("多订阅：都能收到；退订后只少一个；服务 dispose 释放 watch", async () => {
  const fake = createFakeApi({ available: [CUSTOM_MODEL], catalog: [CUSTOM_MODEL] });
  const service = serviceOf(fake.api);
  const received: string[] = [];
  const first = service.onDidChange(() => received.push("first"));
  const second = service.onDidChange(() => received.push("second"));
  await service.getView();

  fake.api.listAvailableModels = async () => [CUSTOM_MODEL, CUSTOM_MODEL_2];
  fake.api.getModelCatalog = async () => [CUSTOM_MODEL, CUSTOM_MODEL_2];
  fake.notifyWatch();
  await waitFor(() => received.length === 2);
  assert.deepEqual([...received].sort(), ["first", "second"]);

  first.dispose();
  fake.api.listAvailableModels = async () => [CUSTOM_MODEL];
  fake.api.getModelCatalog = async () => [CUSTOM_MODEL];
  fake.notifyWatch();
  await waitFor(() => received.length === 3);
  assert.equal(received.filter((entry) => entry === "first").length, 1);
  assert.equal(received.filter((entry) => entry === "second").length, 2);

  // watch 属于服务（事实来源只有一个订阅者），随服务 dispose 回收。
  assert.equal(fake.watchDisposed, 0);
  second.dispose();
  service.dispose();
  assert.equal(fake.watchDisposed, 1);
});

test("dispose 后不再通知，并释放事实来源", async () => {
  const fake = createFakeApi({ available: [CUSTOM_MODEL], catalog: [CUSTOM_MODEL] });
  const service = serviceOf(fake.api);
  let calls = 0;
  service.onDidChange(() => {
    calls += 1;
  });
  await service.getView();
  service.dispose();
  assert.equal(fake.watchDisposed, 1);
  fake.notifyWatch();
  await new Promise((done) => setImmediate(done));
  assert.equal(calls, 0);
  await assert.rejects(() => service.getView(), /已 dispose/u);
});

test("事实读取固定使用本机目标（远端由远端 host 自己回答）", async () => {
  const fake = createFakeApi({ available: [CUSTOM_MODEL], catalog: [CUSTOM_MODEL] });
  const service = serviceOf(fake.api);
  await service.getView();
  service.onDidChange(() => undefined);
  assert.ok(fake.calls.length > 0);
  for (const call of fake.calls) assert.deepEqual(call.target, LOCAL);
  assert.ok(fake.calls.every((call) => call.scope === undefined || call.scope === "global"));
  service.dispose();
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition not reached");
    await new Promise((done) => setTimeout(done, 5));
  }
}
