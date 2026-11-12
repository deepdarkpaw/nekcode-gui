/**
 * models.json 诊断与 nek 的解析规则一致：模型的 api / baseUrl 依次取模型、服务商、内置默认值。
 * 服务商级 api 缺失、但每个模型自带 api（同一网关混用 OpenAI 与 Anthropic 端点）是合法写法。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { NekProviderWrite } from "@zcode/shared/nek-protocol";
import { AGENT_DIR, LOCAL, createHarness, readJson, toWrite } from "./nekConfigApiHarness.js";

const MODELS_PATH = join(AGENT_DIR, "models.json");

function modelsFile(providers: Record<string, unknown>): string {
  return JSON.stringify({ providers }, null, 2);
}

const gatewayWithPerModelApis = {
  baseUrl: "https://gateway.example/v1",
  apiKey: "sk-example-0000",
  models: [
    { id: "chat-model", api: "openai-completions" },
    { id: "claude-model", api: "anthropic-messages" },
    { id: "responses-model", api: "openai-responses" },
  ],
};

async function readView(providers: Record<string, unknown>) {
  const harness = createHarness({ localFiles: { [MODELS_PATH]: modelsFile(providers) } });
  return { harness, view: await harness.api.readModelsConfig(LOCAL) };
}

test("per-model apis on a custom provider are valid and stay visible to the settings page", async () => {
  const { view } = await readView({ gateway: gatewayWithPerModelApis });
  assert.deepEqual(view.diagnostics, []);
  const [provider] = view.providers;
  assert.equal(provider?.api, "");
  assert.deepEqual(
    provider?.models.map((model) => model.api),
    ["openai-completions", "anthropic-messages", "openai-responses"],
  );
  assert.equal(provider?.models[0]?.extra, undefined, "api is a known model field, not an extra");
});

test("custom providers report models nek cannot resolve an api or baseUrl for", async () => {
  const { view } = await readView({
    "half-configured": {
      baseUrl: "https://gateway.example/v1",
      models: [{ id: "has-api", api: "openai-completions" }, { id: "no-api" }],
    },
    "no-base-url": {
      api: "openai-completions",
      models: [{ id: "a" }, { id: "b", baseUrl: "https://b.example/v1" }],
    },
    "provider-level": {
      api: "anthropic-messages",
      baseUrl: "https://claude.example",
      models: [{ id: "inherits" }],
    },
    // 内置服务商总能落到内置默认值。
    anthropic: { baseUrl: "https://proxy.example", models: [{ id: "custom-claude" }] },
  });
  assert.deepEqual(
    view.diagnostics.map(({ severity, message }) => ({ severity, message })),
    [
      {
        severity: "error",
        message:
          'provider "half-configured": no "api" for model "no-api"; set "api" on the provider or on each model to avoid load failures or order-dependent endpoint selection',
      },
      {
        severity: "error",
        message:
          'provider "no-base-url": no "baseUrl" for model "a"; set "baseUrl" on the provider or on each model to avoid load failures or order-dependent endpoint selection',
      },
    ],
  );
});

test("long lists of unresolved models are summarized", async () => {
  const models = Array.from({ length: 8 }, (_, index) => ({ id: `m${index}` }));
  const { view } = await readView({ wide: { baseUrl: "https://wide.example/v1", models } });
  assert.match(view.diagnostics[0]?.message ?? "", /"m0", "m1", "m2", "m3", "m4" \(\+3 more\)/);
});

test("saving a provider without a provider-level api keeps it unset", async () => {
  const { harness, view } = await readView({ gateway: gatewayWithPerModelApis });
  const [provider] = view.providers;
  assert.ok(provider);
  // 界面原样送回读取视图（api 为空串）或干脆不带 api：都不能凭空写入服务商级端点。
  for (const write of [
    toWrite(provider, { baseUrl: "https://gateway.example/v2", apiKey: { keep: true } }),
    toWrite(provider, { api: undefined, apiKey: { keep: true } }),
  ]) {
    const current = await harness.api.readModelsConfig(LOCAL);
    await harness.api.saveProvider(LOCAL, write as unknown as NekProviderWrite, {
      revision: current.revision,
      isNew: false,
    });
    const saved = readJson(harness.local, MODELS_PATH) as {
      providers: Record<string, { api?: string; models: Array<{ api?: string }> }>;
    };
    assert.equal("api" in (saved.providers.gateway ?? {}), false);
    assert.deepEqual(
      saved.providers.gateway?.models.map((model) => model.api),
      ["openai-completions", "anthropic-messages", "openai-responses"],
    );
  }
});
