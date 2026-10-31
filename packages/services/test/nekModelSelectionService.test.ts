/**
 * `IModelSelectionService` 的投影契约：
 * - 候选 = nek 事实的投影（id 不变、档位/能力来自 nek）；
 * - 显式配置的默认模型不可用时不静默换服务商，而是给出 `preferredSelectionIssue`；
 * - 没有显式默认时按目录顺序给出确定性首选；
 * - `revision` 只跟“有哪些可用模型”前进（默认偏好按 workspace 变化不影响版本）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createNekModelFactsSource } from "../src/model-provider/nekModelFacts.js";
import { createNekModelSelectionService } from "../src/model-provider/nekModelSelectionService.js";
import {
  catalogModel,
  countCalls,
  createFakeFactsApi,
  type FakeFactsApi,
} from "./nekModelFactsFixture.js";

const CUSTOM = catalogModel({ provider: "mock", id: "mock-model", name: "Local Mock Model" });
const CUSTOM_2 = catalogModel({
  provider: "mock",
  id: "vendor/mock-model-2",
  reasoning: true,
  thinkingLevels: ["off", "low", "medium", "high"],
  input: ["text", "image"],
});
const OAUTH = catalogModel({
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  reasoning: true,
  thinkingLevels: ["off", "low", "medium", "high"],
});

function serviceOf(api: FakeFactsApi) {
  return createNekModelSelectionService({ facts: createNekModelFactsSource(api) });
}

test("空配置：providers 为空、没有首选、也没有 issue", async () => {
  const api = createFakeFactsApi();
  const service = serviceOf(api);
  const view = await service.getView();
  assert.deepEqual(view.providers, []);
  assert.equal(view.preferredSelection, undefined);
  assert.equal(view.preferredSelectionIssue, undefined);
  assert.ok(view.revision >= 1);
  service.dispose();
});

test("候选按服务商分组，模型 id 与 nek 一致，档位/默认档位/图片能力来自 nek", async () => {
  const api = createFakeFactsApi({
    available: [CUSTOM, CUSTOM_2, OAUTH],
    catalog: [CUSTOM, CUSTOM_2, OAUTH],
    auth: [
      {
        provider: "anthropic",
        name: "Anthropic (Claude Pro/Max)",
        kind: "oauth",
        state: "ok",
        loginMethods: ["oauth"],
      },
    ],
    configuredProviders: [{ id: "mock", name: "公司网关" }],
    effective: { defaultThinkingLevel: "medium" },
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
  assert.deepEqual(
    view.providers[0]?.models.map((model) => [
      model.modelId,
      model.reasoningLevels,
      model.defaultReasoningLevel,
      model.supportsImage,
    ]),
    [
      ["mock-model", ["off"], "off", false],
      // / 保留在 id 里；medium 受支持所以默认就是 medium。
      ["vendor/mock-model-2", ["off", "low", "medium", "high"], "medium", true],
    ],
  );
  service.dispose();
});

test("没有显式默认：按目录顺序给确定性首选（catalog-default）", async () => {
  const api = createFakeFactsApi({
    available: [CUSTOM, OAUTH],
    catalog: [CUSTOM, OAUTH],
    effective: { defaultThinkingLevel: "medium" },
  });
  const service = serviceOf(api);
  const view = await service.getView();
  assert.deepEqual(view.preferredSelection, {
    providerId: "mock",
    modelId: "mock-model",
    options: { reasoningLevel: "off" },
  });
  assert.equal(view.preferredSelectionIssue, undefined);
  service.dispose();
});

test("显式默认可用时用它的模型级思考等级", async () => {
  const api = createFakeFactsApi({
    available: [CUSTOM, OAUTH],
    catalog: [CUSTOM, OAUTH],
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
  assert.equal(view.preferredSelectionIssue, undefined);
  service.dispose();
});

test("显式默认不可用：给 issue，不静默改用别的服务商", async () => {
  const api = createFakeFactsApi({
    available: [CUSTOM],
    catalog: [CUSTOM],
    effective: { defaultProvider: "gone", defaultModel: "gone-model" },
  });
  const service = serviceOf(api);
  const view = await service.getView();
  assert.equal(view.preferredSelection, undefined);
  assert.equal(view.preferredSelectionIssue, "configured-default-unavailable");
  service.dispose();
});

test("显式默认指向一个没有可提交档位的模型也算不可用", async () => {
  const noLevels = catalogModel({ provider: "mock", id: "no-levels", thinkingLevels: [] });
  const api = createFakeFactsApi({
    available: [CUSTOM, noLevels],
    catalog: [CUSTOM, noLevels],
    effective: { defaultProvider: "mock", defaultModel: "no-levels" },
  });
  const service = serviceOf(api);
  const view = await service.getView();
  assert.equal(view.preferredSelection, undefined);
  assert.equal(view.preferredSelectionIssue, "configured-default-unavailable");
  service.dispose();
});

test("非推理模型：默认档位 off 合法，提交 off 通过校验", async () => {
  const api = createFakeFactsApi({
    available: [CUSTOM],
    catalog: [CUSTOM],
    effective: {
      defaultProvider: "mock",
      defaultModel: "mock-model",
      defaultThinkingLevel: "high",
    },
  });
  const service = serviceOf(api);
  const view = await service.getView({
    selection: { providerId: "mock", modelId: "mock-model", options: { reasoningLevel: "off" } },
  });
  assert.deepEqual(view.preferredSelection?.options, { reasoningLevel: "off" });
  assert.deepEqual(view.effectiveSelection, {
    providerId: "mock",
    modelId: "mock-model",
    options: { reasoningLevel: "off" },
  });
  assert.equal(view.selectionIssue, undefined);
  service.dispose();
});

test("getView(input) 解析当前选择：缺失 / provider 缺失 / model 缺失 / 档位不受支持", async () => {
  const api = createFakeFactsApi({
    available: [OAUTH],
    catalog: [OAUTH],
    effective: { defaultThinkingLevel: "medium" },
  });
  const service = serviceOf(api);
  const missing = await service.getView({ selection: null });
  assert.equal(missing.selectionIssue, "selection-missing");

  const missingProvider = await service.getView({
    selection: { providerId: "nope", modelId: "x", options: { reasoningLevel: "off" } },
  });
  assert.equal(missingProvider.selectionIssue, "provider-not-found");
  assert.equal(missingProvider.effectiveSelection, null);

  const missingModel = await service.getView({
    selection: { providerId: "anthropic", modelId: "nope", options: { reasoningLevel: "off" } },
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

test("revision 只随可用模型集合前进；默认偏好变化不改版本", async () => {
  const api = createFakeFactsApi({
    available: [CUSTOM],
    catalog: [CUSTOM],
    effective: { defaultProvider: "mock", defaultModel: "mock-model" },
  });
  const service = serviceOf(api);
  const first = await service.getView();
  const second = await service.getView();
  assert.equal(second.revision, first.revision);

  // 只换默认偏好：不是新版本（草稿运行时不能因此重建），但首选跟着变。
  api.setEffective({ defaultProvider: "mock", defaultModel: "vendor/mock-model-2" });
  api.setCatalog([CUSTOM, CUSTOM_2], [CUSTOM, CUSTOM_2]);
  const grown = await service.getView();
  assert.equal(grown.revision, first.revision + 1);
  assert.deepEqual(grown.preferredSelection, {
    providerId: "mock",
    modelId: "vendor/mock-model-2",
    options: { reasoningLevel: "medium" },
  });

  // 集合不变、只改偏好：版本不变。
  api.setEffective({ defaultProvider: "mock", defaultModel: "mock-model" });
  const sameModels = await service.getView();
  assert.equal(sameModels.revision, grown.revision);
  assert.equal(sameModels.preferredSelection?.modelId, "mock-model");
  service.dispose();
});

test("getView 带 workspacePath 时按项目级配置读取默认偏好", async () => {
  const api = createFakeFactsApi({
    available: [CUSTOM, OAUTH],
    catalog: [CUSTOM, OAUTH],
    effective: { defaultProvider: "mock", defaultModel: "mock-model" },
    effectiveByCwd: {
      "/work/project": {
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-5",
        defaultThinkingLevel: "low",
      },
    },
  });
  const service = serviceOf(api);
  const global = await service.getView();
  assert.equal(global.preferredSelection?.providerId, "mock");
  const project = await service.getView({ selection: null, workspacePath: "/work/project" });
  assert.equal(project.preferredSelection?.providerId, "anthropic");
  assert.deepEqual(project.preferredSelection?.options, { reasoningLevel: "low" });
  assert.deepEqual(
    api.calls.filter((call) => call.method === "readSettings").map((call) => call.scope),
    ["global", "project"],
  );
  // 版本只看“有哪些模型”，两个 workspace 交替读取不会来回跳。
  assert.equal(project.revision, global.revision);
  assert.equal(countCalls(api, "readSettings"), 2);
  service.dispose();
});
