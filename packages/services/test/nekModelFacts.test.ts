/**
 * 事实来源（`NekModelFactsSource`）的契约：
 * - 候选 = 可用性 ∩ 目录；显示名与设置页同源；
 * - 默认模型/思考等级按 workspace 的项目级配置合并；
 * - 配置变化后必须让 nek 重读；重载失败直接抛错（不用旧目录冒充当前事实），重试会再次重载。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  NekModelFactsReloadError,
  createNekModelFactsSource,
} from "../src/model-provider/nekModelFacts.js";
import { clampNekThinkingLevel } from "../src/model-provider/nekThinkingLevel.js";
import { LOCAL, catalogModel, countCalls, createFakeFactsApi } from "./nekModelFactsFixture.js";

const CUSTOM = catalogModel({ provider: "mock", id: "mock-model", name: "Local Mock Model" });
const CUSTOM_2 = catalogModel({ provider: "mock", id: "mock-model-2" });
const OAUTH = catalogModel({
  provider: "anthropic",
  id: "claude-sonnet-4-5",
  reasoning: true,
  thinkingLevels: ["off", "low", "medium", "high"],
});

test("没有可用模型时事实为空", async () => {
  const api = createFakeFactsApi();
  const source = createNekModelFactsSource(api);
  const facts = await source.read();
  assert.deepEqual(facts.providers, []);
  assert.deepEqual(facts.models, []);
  assert.equal(facts.defaults.providerId, undefined);
  source.dispose();
});

test("可用性 ∩ 目录：自定义服务商与 OAuth 内建服务商同时出现", async () => {
  const api = createFakeFactsApi({
    available: [CUSTOM, OAUTH],
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
  });
  const source = createNekModelFactsSource(api);
  const facts = await source.read();
  assert.deepEqual(
    facts.providers.map((provider) => [provider.providerId, provider.displayName]),
    [
      ["mock", "公司网关"],
      ["anthropic", "Anthropic (Claude Pro/Max)"],
    ],
  );
  // 不在可用集里的模型不出现；非推理模型的档位是 nek 自己的 ["off"]。
  assert.deepEqual(
    facts.models.map((model) => [model.modelId, model.reasoningLevels]),
    [
      ["mock-model", ["off"]],
      ["claude-sonnet-4-5", ["off", "low", "medium", "high"]],
    ],
  );
  source.dispose();
});

test("models.json 有条目但 nek 判定不可用时不进候选", async () => {
  const api = createFakeFactsApi({ available: [], catalog: [CUSTOM, CUSTOM_2] });
  const source = createNekModelFactsSource(api);
  const facts = await source.read();
  assert.deepEqual(facts.models, []);
  source.dispose();
});

test("默认模型与思考等级按 workspace 合并项目级配置，并夹到受支持档位", async () => {
  const api = createFakeFactsApi({
    available: [CUSTOM, OAUTH],
    catalog: [CUSTOM, OAUTH],
    effective: {
      defaultProvider: "mock",
      defaultModel: "mock-model",
      defaultThinkingLevel: "low",
      modelThinkingLevels: { "anthropic/claude-sonnet-4-5": "high" },
    },
    effectiveByCwd: {
      // 项目级 effective 是 global ← project 深合并后的结果（nek SettingsManager 同款）。
      "/work/project": {
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-5",
        defaultThinkingLevel: "medium",
        modelThinkingLevels: {},
      },
    },
  });
  const source = createNekModelFactsSource(api);
  const global = await source.read();
  assert.deepEqual(global.defaults, { providerId: "mock", modelId: "mock-model" });
  assert.deepEqual(
    global.models.map((model) => [model.modelId, model.defaultReasoningLevel]),
    [
      // 非推理模型只有 off：默认低档被夹到 off。
      ["mock-model", "off"],
      // 模型级覆盖优先于全局默认；xhigh 不受支持 → 向下找 high。
      ["claude-sonnet-4-5", "high"],
    ],
  );

  const project = await source.read({ cwd: "/work/project" });
  assert.deepEqual(project.defaults, {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-5",
  });
  assert.equal(
    project.models.find((model) => model.modelId === "claude-sonnet-4-5")?.defaultReasoningLevel,
    "medium",
  );
  assert.deepEqual(
    api.calls
      .filter((call) => call.method === "readSettings")
      .map((call) => [call.scope, call.cwd]),
    [
      ["global", undefined],
      ["project", "/work/project"],
    ],
  );
  source.dispose();
});

test("思考等级夹取与 nek clampThinkingLevel 一致：精确 → 向上 → 向下 → 最低", () => {
  assert.equal(clampNekThinkingLevel(["off", "low", "high"], "low"), "low");
  assert.equal(clampNekThinkingLevel(["off", "low", "high"], "medium"), "high");
  assert.equal(clampNekThinkingLevel(["off", "low"], "high"), "low");
  assert.equal(clampNekThinkingLevel(["off"], "medium"), "off");
  assert.equal(clampNekThinkingLevel(["low", "high"], "bogus"), "low");
  assert.equal(clampNekThinkingLevel([], "medium"), undefined);
});

test("配置变化后先让 nek 重载，再读事实", async () => {
  const api = createFakeFactsApi({ available: [CUSTOM], catalog: [CUSTOM] });
  const source = createNekModelFactsSource(api);
  source.onDidChange(() => undefined);
  await source.read();
  assert.equal(countCalls(api, "reloadRunningSessions"), 0);

  api.notifyWatch();
  await source.read();
  assert.equal(countCalls(api, "reloadRunningSessions"), 1);
  // 重载成功即消费掉 pending：重复读取不再重载。
  await source.read();
  assert.equal(countCalls(api, "reloadRunningSessions"), 1);
  source.dispose();
});

test("重载失败：读取抛错、pending 保留，修好后重试会再次重载并读到新事实", async () => {
  const api = createFakeFactsApi({
    available: [CUSTOM],
    catalog: [CUSTOM],
    reloadError: new Error("control process crashed"),
  });
  const source = createNekModelFactsSource(api);
  source.onDidChange(() => undefined);
  await source.read();
  const readsBefore = countCalls(api, "listAvailableModels");

  api.notifyWatch();
  await assert.rejects(
    () => source.read(),
    (error: unknown) =>
      error instanceof NekModelFactsReloadError &&
      error.message.includes("control process crashed"),
  );
  // 失败不能把旧目录当当前事实：这次读取连目录都没读，pending 保留。
  assert.equal(countCalls(api, "listAvailableModels"), readsBefore);

  // 修好配置：解除重载错误、目录多一条模型；重试仍然先重载再读，读到的是新事实。
  api.setReloadError(undefined);
  api.setCatalog([CUSTOM, CUSTOM_2], [CUSTOM, CUSTOM_2]);
  const facts = await source.read();
  assert.equal(countCalls(api, "reloadRunningSessions"), 2);
  assert.deepEqual(
    facts.models.map((model) => model.modelId),
    ["mock-model", "mock-model-2"],
  );
  source.dispose();
});

test("控制进程重载失败按结构化 failures 判定；会话重载失败只记录不阻断", async () => {
  const controlFailure = createFakeFactsApi({
    available: [CUSTOM],
    catalog: [CUSTOM],
    reloadFailures: [{ sessionKey: "control", message: "reload rejected" }],
  });
  const failing = createNekModelFactsSource(controlFailure);
  failing.onDidChange(() => undefined);
  await failing.read();
  controlFailure.notifyWatch();
  await assert.rejects(() => failing.read(), NekModelFactsReloadError);
  assert.equal(countCalls(controlFailure, "listAvailableModels"), 1);
  failing.dispose();

  const sessionFailure = createFakeFactsApi({
    available: [CUSTOM],
    catalog: [CUSTOM],
    reloadFailures: [{ sessionKey: "session-1", message: "session gone" }],
  });
  const tolerant = createNekModelFactsSource(sessionFailure);
  tolerant.onDidChange(() => undefined);
  await tolerant.read();
  sessionFailure.notifyWatch();
  const facts = await tolerant.read();
  assert.equal(facts.models.length, 1);
  tolerant.dispose();
});

test("事实读取固定使用本机目标", async () => {
  const api = createFakeFactsApi({ available: [CUSTOM], catalog: [CUSTOM] });
  const source = createNekModelFactsSource(api);
  await source.read();
  source.onDidChange(() => undefined);
  assert.ok(api.calls.length > 0);
  for (const call of api.calls) assert.deepEqual(call.target, LOCAL);
  source.dispose();
});
