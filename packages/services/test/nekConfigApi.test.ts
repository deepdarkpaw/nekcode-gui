import assert from "node:assert/strict";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { NekMcpServerConfig, NekProviderWrite } from "@zcode/shared/nek-protocol";
import {
  createLocalNekConfigTargetHost,
  createMemoryNekConfigHostExecutor,
} from "../src/nek-config-api/index.js";
import { NekLocatorError } from "../src/nek-agent/nekLocator.js";
import {
  AGENT_DIR,
  HOME,
  LOCAL,
  PROJECT,
  PROJECT_DIR,
  REMOTE,
  createHarness,
  expectNekError,
  readJson,
  toWrite,
} from "./nekConfigApiHarness.js";

/**
 * 设置中心后端的硬约束：
 * - models.json 的编辑保留注释、未知字段与键顺序；
 * - API Key 读取只给掩码，`{keep:true}` 不改原值；
 * - settings.json 嵌套合并、`null` 删除、任何 null 都不落盘；
 * - revision 变了就拒绝写（`conflict`）；
 * - 改名要改写所有引用，并为每个被改动的文件发一次 watch 通知；
 * - 项目级 MCP 条目只覆盖 enabled/exposure/toolExposure。
 */

const MODELS_PATH = join(AGENT_DIR, "models.json");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");
const MCP_PATH = join(AGENT_DIR, "mcp.json");
const PROJECT_MCP_PATH = join(PROJECT_DIR, "mcp.json");
const PRESET_PATH = join(AGENT_DIR, "agents", "reviewer.md");

function modelsFile(providers: string, extraLines = ""): string {
  return `{
  // 用户手写的注释，nek 读的时候会 strip 掉，GUI 必须保留
  "customTop": { "keep": true },${extraLines}
  "providers": ${providers}
}
`;
}

test("models.json edits keep comments, unknown fields and key order", async () => {
  const harness = createHarness({
    localFiles: {
      [MODELS_PATH]: modelsFile(`{
    "local-proxy": {
      "name": "Local proxy",
      // 未知的服务商字段
      "customProviderField": { "nested": 1 },
      "api": "openai-completions",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "sk-literal-1234",
      "models": [
        {
          "id": "qwen3-coder-plus",
          "name": "Qwen3 Coder Plus",
          "unknownModelField": "keep-me",
          "contextWindow": 128000
        }
      ]
    }
  }`),
    },
  });
  const view = await harness.api.readModelsConfig(LOCAL);
  assert.equal(view.providers.length, 1);
  const provider = view.providers[0];
  assert.ok(provider);
  assert.deepEqual(provider.extra, { customProviderField: { nested: 1 } });
  assert.deepEqual(provider.models[0]?.extra, { unknownModelField: "keep-me" });

  const write = toWrite(provider, {
    baseUrl: "http://localhost:8080/v1",
    apiKey: { keep: true },
  }) as unknown as NekProviderWrite;
  await harness.api.saveProvider(LOCAL, write, { revision: view.revision, isNew: false });

  const text = harness.local.files.get(MODELS_PATH) ?? "";
  assert.match(text, /\/\/ 用户手写的注释/);
  assert.match(text, /\/\/ 未知的服务商字段/);
  assert.match(text, /"customProviderField"/);
  assert.match(text, /"unknownModelField": "keep-me"/);
  assert.match(text, /"customTop"/);
  // 键顺序保持：name 在 api 之前，api 在 baseUrl 之前。
  assert.ok(text.indexOf('"name"') < text.indexOf('"api"'));
  assert.ok(text.indexOf('"api"') < text.indexOf('"baseUrl"'));
  assert.match(text, /localhost:8080/);
  // 原子写：先写 .tmp 再 rename。
  assert.ok(harness.local.writes.includes(`write:${MODELS_PATH}.tmp`));
  assert.ok(harness.local.writes.includes(`rename:${MODELS_PATH}.tmp->${MODELS_PATH}`));
});

test("api keys: literal is masked, env and command are described, keep preserves the value", async () => {
  const harness = createHarness({
    localFiles: {
      [MODELS_PATH]: modelsFile(`{
    "literal": { "api": "openai-completions", "baseUrl": "http://a", "apiKey": "sk-abcdef123456", "models": [] },
    "env": { "api": "openai-completions", "baseUrl": "http://b", "apiKey": "\${MY_KEY}", "models": [] },
    "dollar": { "api": "openai-completions", "baseUrl": "http://b2", "apiKey": "$MY_KEY", "models": [] },
    "command": { "api": "openai-completions", "baseUrl": "http://c", "apiKey": "!op read op://k", "models": [] },
    "none": { "api": "openai-completions", "baseUrl": "http://d", "models": [] }
  }`),
    },
  });
  const view = await harness.api.readModelsConfig(LOCAL);
  const byId = new Map(view.providers.map((provider) => [provider.id, provider]));
  assert.deepEqual(byId.get("literal")?.apiKey, { kind: "literal", masked: "••••3456" });
  assert.deepEqual(byId.get("env")?.apiKey, { kind: "env", name: "MY_KEY" });
  assert.deepEqual(byId.get("dollar")?.apiKey, { kind: "env", name: "MY_KEY" });
  assert.deepEqual(byId.get("command")?.apiKey, { kind: "command", command: "op read op://k" });
  assert.deepEqual(byId.get("none")?.apiKey, { kind: "none" });
  // 内置服务商 ID 的覆盖标记
  assert.equal(byId.get("literal")?.overridesBuiltin, false);
  assert.equal(view.providers.length, 5);

  const literal = byId.get("literal");
  assert.ok(literal);
  await harness.api.saveProvider(
    LOCAL,
    toWrite(literal, { name: "renamed", apiKey: { keep: true } }) as never,
    { revision: view.revision, isNew: false },
  );
  const afterKeep = readJson(harness.local, MODELS_PATH) as {
    providers: Record<string, { apiKey?: string; name?: string }>;
  };
  assert.equal(afterKeep.providers.literal?.apiKey, "sk-abcdef123456");
  assert.equal(afterKeep.providers.literal?.name, "renamed");

  const current = await harness.api.readModelsConfig(LOCAL);
  const currentLiteral = current.providers.find((provider) => provider.id === "literal");
  assert.ok(currentLiteral);
  await harness.api.saveProvider(
    LOCAL,
    toWrite(currentLiteral, { apiKey: "sk-new-key-9999" }) as never,
    { revision: current.revision, isNew: false },
  );
  const afterReplace = readJson(harness.local, MODELS_PATH) as {
    providers: Record<string, { apiKey?: string }>;
  };
  assert.equal(afterReplace.providers.literal?.apiKey, "sk-new-key-9999");
  assert.equal(afterReplace.providers.env?.apiKey, "${MY_KEY}");
});

test("settings: nested merge, null deletes the key, no null is ever persisted", async () => {
  const harness = createHarness({
    localFiles: {
      [SETTINGS_PATH]: JSON.stringify(
        {
          defaultProvider: "anthropic",
          compaction: { enabled: true, reserveTokens: 30000, content: { thinkingMaxChars: 3000 } },
          retry: { enabled: true },
          customKey: "hidden",
        },
        null,
        2,
      ),
    },
  });
  const read = await harness.api.readSettings(LOCAL, "global");
  assert.equal(read.values.defaultProvider, "anthropic");
  // defaults 必须填全
  assert.equal(read.defaults.defaultThinkingLevel, "medium");
  assert.equal(read.defaults.compaction?.reserveTokens, 16384);
  assert.equal(read.defaults.retry?.maxAgentDelayMs, 60000);
  // effective = defaults ← 文件
  assert.equal(read.effective.compaction?.reserveTokens, 30000);
  assert.equal(read.effective.branchSummary?.reserveTokens, 16384);
  assert.deepEqual(read.values.extra, { customKey: "hidden" });

  await harness.api.patchSettings(
    LOCAL,
    "global",
    {
      defaultModel: "anthropic/claude-sonnet-4-5",
      compaction: { keepRecentTokens: 12000, content: { toolResultMaxChars: 4000 } },
    },
    { revision: read.revision },
  );
  const merged = readJson(harness.local, SETTINGS_PATH) as Record<string, unknown> & {
    compaction: {
      reserveTokens?: number;
      keepRecentTokens?: number;
      content: Record<string, number>;
    };
  };
  assert.equal(merged.defaultModel, "anthropic/claude-sonnet-4-5");
  assert.equal(merged.compaction.reserveTokens, 30000, "nested merge keeps untouched keys");
  assert.equal(merged.compaction.keepRecentTokens, 12000);
  assert.equal(merged.compaction.content.thinkingMaxChars, 3000);
  assert.equal(merged.compaction.content.toolResultMaxChars, 4000);

  const before = await harness.api.readSettings(LOCAL, "global");
  await harness.api.patchSettings(
    LOCAL,
    "global",
    { retry: null, compaction: { content: { thinkingMaxChars: null } } },
    { revision: before.revision },
  );
  const text = harness.local.files.get(SETTINGS_PATH) ?? "";
  assert.doesNotMatch(text, /null/);
  const afterDelete = readJson(harness.local, SETTINGS_PATH) as Record<string, unknown> & {
    compaction: { content: Record<string, number> };
  };
  assert.equal("retry" in afterDelete, false, "null deletes the top-level key");
  assert.equal(
    "thinkingMaxChars" in afterDelete.compaction.content,
    false,
    "null deletes a nested key",
  );
  assert.equal(afterDelete.compaction.content.toolResultMaxChars, 4000);
});

test("web search: defaults match nek and merged writes require an explicit provider", async () => {
  const harness = createHarness();
  const initial = await harness.api.readSettings(LOCAL, "global");
  assert.deepEqual(initial.defaults.webSearch, { provider: "tavily", numResults: 8 });
  for (const webSearch of [
    { apiKey: "$SEARCH_API_KEY" },
    { endpoint: "https://search.example/search" },
    { provider: "unknown" },
    { provider: "tavily", numResults: 21 },
    { provider: "exa", numResults: 0 },
    { numResults: 1.5 },
  ]) {
    await expectNekError(
      () =>
        harness.api.patchSettings(LOCAL, "global", { webSearch } as never, {
          revision: initial.revision,
        }),
      "validation",
    );
    assert.equal(harness.local.files.has(SETTINGS_PATH), false);
  }
  await harness.api.patchSettings(
    LOCAL,
    "global",
    {
      webSearch: {
        provider: "tavily",
        apiKey: "$TAVILY_API_KEY",
        numResults: 20,
        customSearchFlag: true,
      },
    } as never,
    { revision: initial.revision },
  );
  // 文件里已经有 provider 时只改 key 是合法的：不需要每次都重复写 provider。
  const next = await harness.api.readSettings(LOCAL, "global");
  await harness.api.patchSettings(
    LOCAL,
    "global",
    { webSearch: { apiKey: "$TAVILY_ROTATED" } },
    { revision: next.revision },
  );
  const rotated = await harness.api.readSettings(LOCAL, "global");
  await harness.api.patchSettings(
    LOCAL,
    "global",
    { webSearch: { numResults: 8 } },
    { revision: rotated.revision },
  );
  const final = await harness.api.readSettings(LOCAL, "global");
  assert.deepEqual(final.values.webSearch, {
    provider: "tavily",
    apiKey: "$TAVILY_ROTATED",
    numResults: 8,
    customSearchFlag: true,
  });
  await expectNekError(
    () =>
      harness.api.patchSettings(LOCAL, "global", { webSearch: { provider: null } } as never, {
        revision: final.revision,
      }),
    "validation",
  );
  assert.deepEqual(
    (await harness.api.readSettings(LOCAL, "global")).values.webSearch,
    final.values.webSearch,
  );
  await harness.api.dispose();
});

test("web search: remote settings and probe keep credentials on the target host", async () => {
  const harness = createHarness();
  const read = await harness.api.readSettings(REMOTE, "global");
  await harness.api.patchSettings(
    REMOTE,
    "global",
    { webSearch: { provider: "exa", apiKey: "$REMOTE_SEARCH_KEY", numResults: 8 } },
    { revision: read.revision },
  );
  assert.deepEqual((readJson(harness.remote, read.path) as { webSearch: unknown }).webSearch, {
    provider: "exa",
    apiKey: "$REMOTE_SEARCH_KEY",
    numResults: 8,
  });
  assert.equal(harness.local.files.has(SETTINGS_PATH), false);
  assert.equal((await harness.api.testWebSearch(REMOTE, "fixture query")).ok, true);
  assert.deepEqual(
    harness.control.commands.findLast((command) => command.type === "test_web_search"),
    { type: "test_web_search", query: "fixture query" },
  );
  await harness.api.dispose();
});

test("web search: project keys can inherit an explicit global provider", async () => {
  const harness = createHarness({
    localFiles: { [SETTINGS_PATH]: JSON.stringify({ webSearch: { provider: "tavily" } }) },
  });
  const read = await harness.api.readSettings(LOCAL, "project", PROJECT);
  await harness.api.patchSettings(
    LOCAL,
    "project",
    { webSearch: { apiKey: "$PROJECT_SEARCH_KEY" } },
    { revision: read.revision, cwd: PROJECT },
  );
  const result = await harness.api.readSettings(LOCAL, "project", PROJECT);
  assert.equal(result.effective.webSearch?.provider, "tavily");
  assert.equal(result.effective.webSearch?.apiKey, "$PROJECT_SEARCH_KEY");
  assert.equal(result.diagnostics.length, 0);
  await harness.api.dispose();
});

test("web search: a key without any provider is rejected even across scopes", async () => {
  const harness = createHarness();
  const global = await harness.api.readSettings(LOCAL, "global");
  const project = await harness.api.readSettings(LOCAL, "project", PROJECT);
  // 项目层只写 key、全局也没有 provider：合并后仍然非法，必须在落盘前失败。
  const error = await expectNekError(
    () =>
      harness.api.patchSettings(
        LOCAL,
        "project",
        { webSearch: { apiKey: "$PROJECT_KEY" } },
        { revision: project.revision, cwd: PROJECT },
      ),
    "validation",
  );
  assert.ok(error.fieldErrors?.["webSearch.provider"]);
  assert.equal(harness.local.files.has(join(PROJECT_DIR, "settings.json")), false);
  // 全局层同样不能只写 endpoint。
  await expectNekError(
    () =>
      harness.api.patchSettings(
        LOCAL,
        "global",
        { webSearch: { endpoint: "https://search.example/mcp" } },
        { revision: global.revision },
      ),
    "validation",
  );
  assert.equal(harness.local.files.has(SETTINGS_PATH), false);
  await harness.api.dispose();
});

test("web search: a legacy key without a provider is diagnosed but does not block other edits", async () => {
  // 旧版界面写过 key 且没有 provider：nek 会拒绝启动，但用户仍要能改别的设置。
  const harness = createHarness({
    localFiles: {
      [SETTINGS_PATH]: JSON.stringify({ webSearch: { apiKey: "$LEGACY_SEARCH_KEY" } }),
    },
  });
  const read = await harness.api.readSettings(LOCAL, "global");
  assert.equal(read.diagnostics.length, 1);
  assert.match(read.diagnostics[0]?.message ?? "", /provider/);

  await harness.api.patchSettings(LOCAL, "global", { theme: "dark" }, { revision: read.revision });
  const afterGlobal = readJson(harness.local, SETTINGS_PATH) as Record<string, unknown> & {
    webSearch: Record<string, unknown>;
  };
  assert.equal(afterGlobal.theme, "dark");
  assert.equal(
    afterGlobal.webSearch.apiKey,
    "$LEGACY_SEARCH_KEY",
    "the legacy key is never dropped or rewritten",
  );

  // 项目作用域也一样：全局的旧瑕疵不能连带拒绝项目写入。
  const project = await harness.api.readSettings(LOCAL, "project", PROJECT);
  await harness.api.patchSettings(
    LOCAL,
    "project",
    { theme: "light" },
    { revision: project.revision, cwd: PROJECT },
  );
  assert.equal(
    (readJson(harness.local, join(PROJECT_DIR, "settings.json")) as Record<string, unknown>).theme,
    "light",
  );

  // 修好它只需要显式选一个 provider：key 原样保留，不猜服务商也不删凭据。
  const current = await harness.api.readSettings(LOCAL, "global");
  await harness.api.patchSettings(
    LOCAL,
    "global",
    { webSearch: { provider: "exa" } },
    { revision: current.revision },
  );
  const repaired = await harness.api.readSettings(LOCAL, "global");
  assert.deepEqual(repaired.values.webSearch, { apiKey: "$LEGACY_SEARCH_KEY", provider: "exa" });
  assert.deepEqual(repaired.diagnostics, []);
  await harness.api.dispose();
});

test("web search: project overrides merge with the global provider instead of repeating it", async () => {
  const harness = createHarness({
    localFiles: {
      [SETTINGS_PATH]: JSON.stringify({
        webSearch: { provider: "exa", apiKey: "$GLOBAL_EXA_KEY", numResults: 4 },
      }),
    },
  });
  const project = await harness.api.readSettings(LOCAL, "project", PROJECT);
  await harness.api.patchSettings(
    LOCAL,
    "project",
    { webSearch: { numResults: 12 } },
    { revision: project.revision, cwd: PROJECT },
  );
  const merged = await harness.api.readSettings(LOCAL, "project", PROJECT);
  assert.deepEqual(merged.effective.webSearch, {
    provider: "exa",
    apiKey: "$GLOBAL_EXA_KEY",
    numResults: 12,
  });
  assert.deepEqual(merged.values.webSearch, { numResults: 12 });
  assert.deepEqual(merged.diagnostics, []);
  await harness.api.dispose();
});

test("web search: empty endpoint/apiKey values are rejected like nek rejects them", async () => {
  const harness = createHarness();
  const read = await harness.api.readSettings(LOCAL, "global");
  // nek 对 endpoint/apiKey 的要求是 trim() 后非空：空串和纯空白都会让会话启动失败。
  for (const webSearch of [
    { provider: "tavily", apiKey: "" },
    { provider: "tavily", apiKey: "   " },
    { provider: "exa", endpoint: "" },
    { provider: "exa", endpoint: "  " },
  ]) {
    const error = await expectNekError(
      () =>
        harness.api.patchSettings(LOCAL, "global", { webSearch } as never, {
          revision: read.revision,
        }),
      "validation",
    );
    assert.ok(
      error.fieldErrors?.["webSearch.apiKey"] ?? error.fieldErrors?.["webSearch.endpoint"],
      `${JSON.stringify(webSearch)} must be attributed to the credential field`,
    );
    assert.equal(harness.local.files.has(SETTINGS_PATH), false);
  }
  await harness.api.dispose();
});

test("web search: stored empty credentials are diagnosed and can be repaired", async () => {
  const harness = createHarness({
    localFiles: {
      [SETTINGS_PATH]: JSON.stringify({ webSearch: { provider: "exa", apiKey: "  " } }),
    },
  });
  const read = await harness.api.readSettings(LOCAL, "global");
  assert.equal(read.diagnostics.length, 1);
  assert.match(read.diagnostics[0]?.message ?? "", /webSearch\.apiKey/);

  // 现存空值不能连带拒绝无关写入……
  await harness.api.patchSettings(LOCAL, "global", { theme: "dark" }, { revision: read.revision });
  const after = await harness.api.readSettings(LOCAL, "global");
  const written = readJson(harness.local, SETTINGS_PATH) as {
    theme?: string;
    webSearch: Record<string, unknown>;
  };
  assert.equal(written.theme, "dark");
  assert.equal(
    written.webSearch.apiKey,
    "  ",
    "the GUI never rewrites the stored value on its own",
  );

  // ……清掉它就是修复。
  await harness.api.patchSettings(
    LOCAL,
    "global",
    { webSearch: { apiKey: null } },
    { revision: after.revision },
  );
  const repaired = await harness.api.readSettings(LOCAL, "global");
  assert.deepEqual(repaired.values.webSearch, { provider: "exa" });
  assert.deepEqual(repaired.diagnostics, []);
  await harness.api.dispose();
});

test("web search: a legacy key does not let new credentials in without a provider", async () => {
  const harness = createHarness({
    localFiles: { [SETTINGS_PATH]: JSON.stringify({ webSearch: { apiKey: "$OLD_KEY" } }) },
  });
  const read = await harness.api.readSettings(LOCAL, "global");
  // 旧歧义不是新非法写入的通行证：换 key / 新增 endpoint 仍然需要显式 provider。
  for (const webSearch of [
    { apiKey: "$NEW_KEY" },
    { endpoint: "https://search.example/mcp" },
    { apiKey: "$OLD_KEY", endpoint: "https://search.example/mcp" },
  ]) {
    const error = await expectNekError(
      () =>
        harness.api.patchSettings(LOCAL, "global", { webSearch } as never, {
          revision: read.revision,
        }),
      "validation",
    );
    assert.ok(error.fieldErrors?.["webSearch.provider"]);
  }
  assert.deepEqual(readJson(harness.local, SETTINGS_PATH), { webSearch: { apiKey: "$OLD_KEY" } });

  // 逐步修复：先改无关的结果数，再清掉旧 key，每一步都合法。
  await harness.api.patchSettings(
    LOCAL,
    "global",
    { webSearch: { numResults: 4 } },
    { revision: read.revision },
  );
  const afterNum = await harness.api.readSettings(LOCAL, "global");
  await harness.api.patchSettings(
    LOCAL,
    "global",
    { webSearch: { apiKey: null } },
    { revision: afterNum.revision },
  );
  const repaired = await harness.api.readSettings(LOCAL, "global");
  assert.deepEqual(repaired.values.webSearch, { numResults: 4 });
  assert.deepEqual(repaired.diagnostics, []);
  await harness.api.dispose();
});

test("web search: an old target refuses new Tavily configuration but keeps Exa writable", async () => {
  const harness = createHarness({ nekVersion: "0.4.3" });
  const read = await harness.api.readSettings(LOCAL, "global");
  const error = await expectNekError(
    () =>
      harness.api.patchSettings(
        LOCAL,
        "global",
        { webSearch: { provider: "tavily", apiKey: "$TAVILY_KEY" } },
        { revision: read.revision },
      ),
    "validation",
  );
  assert.match(error.message, /0\.5\.0-beta\.1/);
  assert.ok(error.fieldErrors?.["webSearch.provider"]);
  assert.equal(harness.local.files.has(SETTINGS_PATH), false);

  // 旧 nek 忽略 provider、永远走 Exa：显式 Exa 在旧目标上照写，不会被静默改写。
  await harness.api.patchSettings(
    LOCAL,
    "global",
    { webSearch: { provider: "exa", apiKey: "$EXA_KEY" } },
    { revision: read.revision },
  );
  assert.deepEqual((readJson(harness.local, SETTINGS_PATH) as { webSearch: unknown }).webSearch, {
    provider: "exa",
    apiKey: "$EXA_KEY",
  });
  await harness.api.dispose();
});

test("web search: an old target keeps an existing Tavily config but refuses new keys", async () => {
  const harness = createHarness({
    nekVersion: "0.4.3",
    localFiles: {
      [SETTINGS_PATH]: JSON.stringify({ webSearch: { provider: "tavily", apiKey: "$OLD_TAVILY" } }),
    },
  });
  const read = await harness.api.readSettings(LOCAL, "global");
  // 与版本无关的字段照常保存：旧 Tavily 配置原样留着，不替用户改写。
  await harness.api.patchSettings(
    LOCAL,
    "global",
    { webSearch: { numResults: 5 } },
    { revision: read.revision },
  );
  const afterNum = await harness.api.readSettings(LOCAL, "global");
  assert.deepEqual(afterNum.values.webSearch, {
    provider: "tavily",
    apiKey: "$OLD_TAVILY",
    numResults: 5,
  });

  // 换 Tavily 的 key 等于把它交给 Exa：拒绝。
  await expectNekError(
    () =>
      harness.api.patchSettings(
        LOCAL,
        "global",
        { webSearch: { apiKey: "$NEW_TAVILY" } },
        { revision: afterNum.revision },
      ),
    "validation",
  );
  // 清理（删除凭据）始终允许。
  await harness.api.patchSettings(
    LOCAL,
    "global",
    { webSearch: { apiKey: null } },
    { revision: afterNum.revision },
  );
  const cleaned = await harness.api.readSettings(LOCAL, "global");
  assert.deepEqual(cleaned.values.webSearch, { provider: "tavily", numResults: 5 });
  await harness.api.dispose();
});

test("web search: an unknown target version cannot pose as Tavily support", async () => {
  const harness = createHarness({ nekVersion: null });
  const read = await harness.api.readSettings(LOCAL, "global");
  const error = await expectNekError(
    () =>
      harness.api.patchSettings(
        LOCAL,
        "global",
        { webSearch: { provider: "tavily", apiKey: "$TAVILY_KEY" } },
        { revision: read.revision },
      ),
    "validation",
  );
  assert.match(error.message, /version unknown/);
  assert.equal(harness.local.files.has(SETTINGS_PATH), false);

  await harness.api.patchSettings(
    LOCAL,
    "global",
    { webSearch: { provider: "exa", apiKey: "$EXA_KEY" } },
    { revision: read.revision },
  );
  assert.deepEqual((readJson(harness.local, SETTINGS_PATH) as { webSearch: unknown }).webSearch, {
    provider: "exa",
    apiKey: "$EXA_KEY",
  });
  await harness.api.dispose();
});

test("settings: a concurrent nek write inside the lock is not overwritten", async () => {
  const harness = createHarness({
    localFiles: { [SETTINGS_PATH]: JSON.stringify({ theme: "dark" }) },
  });
  const read = await harness.api.readSettings(LOCAL, "global");

  // 模拟 nek 在我们拿到锁之前写入了它自己的字段。
  const originalLock = harness.local.lock;
  assert.ok(originalLock);
  harness.local.lock = {
    runLocked: (path, critical) => {
      harness.local.setFile(path, JSON.stringify({ theme: "dark", lastChangelogVersion: "0.3.2" }));
      originalLock.runLocked(path, critical);
    },
  };
  const conflict = await expectNekError(
    async () =>
      await harness.api.patchSettings(
        LOCAL,
        "global",
        { defaultModel: "x/y" },
        {
          revision: read.revision,
        },
      ),
    "conflict",
  );
  assert.match(conflict.message, /modified externally/);
  // 被拒绝的写入没有落盘：nek 写的内容还在，我们的字段还没写。
  const rejected = readJson(harness.local, SETTINGS_PATH) as Record<string, unknown>;
  assert.equal(rejected.lastChangelogVersion, "0.3.2");
  assert.equal(rejected.defaultModel, undefined);

  // 重新读取后写入成功，两边的内容都在（没有丢更新）。
  harness.local.lock = originalLock;
  const refreshed = await harness.api.readSettings(LOCAL, "global");
  await harness.api.patchSettings(
    LOCAL,
    "global",
    { defaultModel: "x/y" },
    { revision: refreshed.revision },
  );
  const merged = readJson(harness.local, SETTINGS_PATH) as Record<string, unknown>;
  assert.equal(merged.defaultModel, "x/y");
  assert.equal(merged.lastChangelogVersion, "0.3.2");
  assert.equal(merged.theme, "dark");
});

test("stale revisions are rejected with a conflict error", async () => {
  const harness = createHarness({
    localFiles: {
      [MODELS_PATH]: modelsFile(
        `{
    "local": { "api": "openai-completions", "baseUrl": "http://a", "models": [] }
  }`,
      ),
      [SETTINGS_PATH]: JSON.stringify({ defaultProvider: "local" }),
    },
  });
  const first = await harness.api.readModelsConfig(LOCAL);
  const provider = first.providers[0];
  assert.ok(provider);
  await harness.api.saveProvider(LOCAL, toWrite(provider, { baseUrl: "http://b" }) as never, {
    revision: first.revision,
    isNew: false,
  });
  const error = await expectNekError(
    async () =>
      await harness.api.saveProvider(LOCAL, toWrite(provider, { baseUrl: "http://c" }) as never, {
        revision: first.revision,
        isNew: false,
      }),
    "conflict",
  );
  assert.equal(error.code, "conflict");

  // 同一个旧令牌也不能再写 settings
  const settings = await harness.api.readSettings(LOCAL, "global");
  await harness.api.patchSettings(
    LOCAL,
    "global",
    { defaultModel: "local/a" },
    { revision: settings.revision },
  );
  await expectNekError(
    async () =>
      await harness.api.patchSettings(
        LOCAL,
        "global",
        { defaultModel: "local/b" },
        { revision: settings.revision },
      ),
    "conflict",
  );

  // 删除不存在的服务商是校验错误，不是静默成功
  const current = await harness.api.readModelsConfig(LOCAL);
  const validation = await expectNekError(
    async () => await harness.api.deleteProvider(LOCAL, "missing", { revision: current.revision }),
    "validation",
  );
  assert.deepEqual(validation.fieldErrors, { providerId: "unknown" });
});

test("renaming a provider rewrites every reference and notifies each changed file", async () => {
  const preset = `---
name: reviewer
description: Reviews diffs
model: local/qwen3-coder-plus
thinking: high
custom: keep
---

Review the changes.
`;
  const harness = createHarness({
    localFiles: {
      [MODELS_PATH]: modelsFile(`{
    "local": { "api": "openai-completions", "baseUrl": "http://a", "models": [{ "id": "qwen3-coder-plus" }] },
    "other": { "api": "openai-completions", "baseUrl": "http://b", "models": [] }
  }`),
      [SETTINGS_PATH]: JSON.stringify(
        {
          defaultProvider: "local",
          defaultModel: "local/qwen3-coder-plus",
          enabledModels: ["local/qwen3-coder-plus:high", "other/model"],
          compaction: { model: "local/qwen3-coder-plus" },
          modelThinkingLevels: { "local/qwen3-coder-plus": "medium" },
        },
        null,
        2,
      ),
      [PRESET_PATH]: preset,
    },
  });
  const changes: Array<{ file: string; revision: string }> = [];
  const unsubscribe = harness.api.watch(LOCAL, (change) => changes.push(change));
  await Promise.resolve();

  const models = await harness.api.readModelsConfig(LOCAL);
  const references = await harness.api.getProviderReferences(LOCAL, "local");
  assert.equal(references.defaultModel, true);
  assert.deepEqual(references.enabledModels, ["local/qwen3-coder-plus:high"]);
  assert.equal(references.compactionModel, true);
  assert.deepEqual(references.modelThinkingLevels, ["local/qwen3-coder-plus"]);
  assert.deepEqual(
    references.agentPresets.map((entry) => entry.name),
    ["reviewer"],
  );

  const preview = await harness.api.previewProviderRename(LOCAL, "local", "local2");
  assert.equal(preview.to, "local2");
  assert.equal(preview.references.compactionModel, true);

  await harness.api.renameProvider(LOCAL, "local", "local2", { revision: models.revision });
  unsubscribe();

  const modelsAfter = readJson(harness.local, MODELS_PATH) as {
    providers: Record<string, { baseUrl: string; models: Array<{ id: string }> }>;
  };
  assert.equal(modelsAfter.providers.local, undefined);
  assert.equal(modelsAfter.providers.local2?.models[0]?.id, "qwen3-coder-plus");

  const settingsAfter = readJson(harness.local, SETTINGS_PATH) as Record<string, unknown> & {
    compaction: Record<string, unknown>;
    modelThinkingLevels: Record<string, string>;
  };
  assert.equal(settingsAfter.defaultProvider, "local2");
  assert.equal(settingsAfter.defaultModel, "local2/qwen3-coder-plus");
  assert.deepEqual(settingsAfter.enabledModels, ["local2/qwen3-coder-plus:high", "other/model"]);
  assert.equal(settingsAfter.compaction.model, "local2/qwen3-coder-plus");
  assert.deepEqual(settingsAfter.modelThinkingLevels, { "local2/qwen3-coder-plus": "medium" });

  const presetAfter = harness.local.files.get(PRESET_PATH) ?? "";
  assert.match(presetAfter, /model: local2\/qwen3-coder-plus/);
  assert.match(presetAfter, /^custom: keep$/m);
  assert.match(presetAfter, /Review the changes\./);

  const notified = new Set(changes.map((change) => change.file));
  assert.ok(notified.has(MODELS_PATH), "models.json change is published");
  assert.ok(notified.has(SETTINGS_PATH), "settings.json change is published");
  assert.ok(notified.has(PRESET_PATH), "agent preset change is published");

  // 目标 ID 已存在时拒绝改名（预览阶段就拦住）
  const duplicate = await expectNekError(
    async () => await harness.api.previewProviderRename(LOCAL, "local2", "other"),
    "validation",
  );
  assert.deepEqual(duplicate.fieldErrors, { to: "duplicate" });
});

test("mcp: project entries only override and renames delete the old key", async () => {
  const harness = createHarness({
    localFiles: {
      [MCP_PATH]: JSON.stringify({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
          },
          docs: { type: "http", url: "https://example.com/mcp" },
        },
      }),
      [PROJECT_MCP_PATH]: JSON.stringify({ mcpServers: { filesystem: { enabled: false } } }),
    },
  });
  const globalView = await harness.api.readMcpConfig(LOCAL, "global");
  assert.equal(globalView.servers.length, 2);
  assert.equal(
    globalView.servers.every((server) => !server.isOverride),
    true,
  );

  const projectView = await harness.api.readMcpConfig(LOCAL, "project", PROJECT);
  const filesystem = projectView.servers.find((server) => server.name === "filesystem");
  assert.ok(filesystem);
  assert.equal(filesystem.isOverride, true);
  assert.equal(filesystem.config.enabled, false);
  assert.equal((filesystem.config as { command?: string }).command, "npx", "global config is kept");
  assert.deepEqual(projectView.diagnostics, []);

  // 项目级不允许写完整配置
  await expectNekError(
    async () =>
      await harness.api.saveMcpServer(
        LOCAL,
        "project",
        { name: "sentry", config: { command: "sentry-mcp" } as NekMcpServerConfig },
        { revision: projectView.revision, cwd: PROJECT },
      ),
    "validation",
  );

  // 全局改名：旧键必须删掉
  await harness.api.saveMcpServer(
    LOCAL,
    "global",
    {
      name: "docs-v2",
      previousName: "docs",
      config: { type: "http", url: "https://example.com/v2" },
    },
    { revision: globalView.revision },
  );
  const afterRename = readJson(harness.local, MCP_PATH) as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
  assert.equal(afterRename.mcpServers.docs, undefined);
  assert.equal(afterRename.mcpServers["docs-v2"]?.url, "https://example.com/v2");

  // 导入预览能同时接受 `{mcpServers:{...}}` 与单个 server
  const preview = await harness.api.previewMcpImport(
    LOCAL,
    "global",
    JSON.stringify({ mcpServers: { filesystem: { command: "x" }, broken: {} } }),
  );
  assert.equal(preview.servers[0]?.name, "filesystem");
  assert.equal(preview.servers[0]?.conflict, true);
  assert.equal(preview.errors.length, 1);
  const single = await harness.api.previewMcpImport(
    LOCAL,
    "global",
    JSON.stringify({ command: "sentry-mcp", args: ["--stdio"] }),
  );
  assert.equal(single.servers.length, 1);
  assert.equal(single.servers[0]?.name, "server");

  // 没有会话进程时，状态查询返回 undefined，动作给出明确错误
  assert.equal(await harness.api.getMcpStatus(LOCAL), undefined);
  const actionError = await expectNekError(
    async () => await harness.api.mcpServerAction(LOCAL, "filesystem", "reconnect"),
    "validation",
  );
  assert.match(actionError.message, /no nek session is running/);

  // 测试连接走控制进程
  const testResult = await harness.api.testMcpServer(LOCAL, { name: "filesystem" });
  assert.deepEqual(testResult, { ok: true, latencyMs: 5, tools: [{ name: "ping" }] });

  const deleted = await harness.api.deleteMcpServer(LOCAL, "global", "docs-v2", {
    revision: (await harness.api.readMcpConfig(LOCAL, "global")).revision,
  });
  assert.ok(deleted.revision.length > 0);
  const afterDelete = readJson(harness.local, MCP_PATH) as { mcpServers: Record<string, unknown> };
  assert.equal(afterDelete.mcpServers["docs-v2"], undefined);
});

test("agent presets round-trip frontmatter, body and unknown keys", async () => {
  const harness = createHarness({
    localFiles: {
      [PRESET_PATH]: `---
name: reviewer
description: Reviews diffs
model: anthropic/claude-sonnet-4-5
thinking: high
context_window: 200000
readonly: true
tools: [read, grep]
disallowed_tools: bash
is_background: true
autonomous: true
custom: keep
---

Review the changes.
`,
    },
  });
  const view = await harness.api.listAgentPresets(LOCAL);
  const list = view.entries;
  const builtin = list.filter((entry) => entry.source === "builtin");
  assert.equal(builtin.length, 2, "builtin presets are listed");
  assert.equal(
    builtin.every((entry) => entry.revision.length > 0),
    true,
  );
  const user = list.find((entry) => entry.preset.name === "reviewer");
  assert.ok(user);
  assert.equal(user.source, "user");
  assert.equal(user.preset.thinking, "high");
  assert.equal(user.preset.contextWindow, 200000);
  assert.equal(user.preset.readonly, true);
  assert.deepEqual(user.preset.tools, ["read", "grep"]);
  assert.deepEqual(user.preset.disallowedTools, ["bash"]);
  assert.equal(user.preset.isBackground, true);
  assert.equal(user.preset.autonomous, true);
  assert.match(user.preset.instructions, /Review the changes/);

  await harness.api.saveAgentPreset(
    LOCAL,
    "global",
    { ...user.preset, description: "Reviews diffs carefully" },
    { revision: user.revision },
  );
  const text = harness.local.files.get(PRESET_PATH) ?? "";
  assert.match(text, /description: Reviews diffs carefully/);
  assert.match(text, /context_window: 200000/);
  assert.match(text, /custom: keep/, "unknown frontmatter keys are preserved");
  assert.match(text, /Review the changes\./);

  const reviewerRevision = (await harness.api.listAgentPresets(LOCAL)).entries.find(
    (entry) => entry.preset.name === "reviewer",
  )?.revision;
  assert.ok(reviewerRevision);
  const renamed = await harness.api.saveAgentPreset(
    LOCAL,
    "global",
    { ...user.preset, name: "diff-reviewer" },
    { revision: reviewerRevision, previousName: "reviewer" },
  );
  assert.ok(renamed.revision.length > 0);
  assert.equal(harness.local.files.has(PRESET_PATH), false, "old preset file is removed");
  assert.equal(harness.local.files.has(join(AGENT_DIR, "agents", "diff-reviewer.md")), true);

  // 非法预设名是校验错误
  await expectNekError(
    async () =>
      await harness.api.saveAgentPreset(
        LOCAL,
        "global",
        { ...user.preset, name: "bad/name", description: "x" },
        { revision: "absent" },
      ),
    "validation",
  );

  await expectNekError(
    async () =>
      await harness.api.deleteAgentPreset(LOCAL, "global", "missing", { revision: "absent" }),
    "validation",
  );
  const current = await harness.api.listAgentPresets(LOCAL);
  const target = current.entries.find((entry) => entry.preset.name === "diff-reviewer");
  assert.ok(target);
  await harness.api.deleteAgentPreset(LOCAL, "global", "diff-reviewer", {
    revision: target.revision,
  });
  assert.equal(harness.local.files.has(join(AGENT_DIR, "agents", "diff-reviewer.md")), false);
});

test("nek.yaml patches merge sections and reject unknown keys", async () => {
  const yamlPath = join(AGENT_DIR, "nek.yaml");
  const harness = createHarness({ localFiles: { [yamlPath]: "plan:\n  shortcut: ctrl+m\n" } });
  const read = await harness.api.readNekYaml(LOCAL, "global");
  assert.equal(read.values.plan?.shortcut, "ctrl+m");
  assert.equal(read.defaults.subagent.maxConcurrent, 6);

  await harness.api.patchNekYaml(
    LOCAL,
    "global",
    { todo: { widgetMaxLines: 12 }, plan: { dir: "plans" } },
    { revision: read.revision },
  );
  const patched = harness.local.files.get(yamlPath) ?? "";
  assert.match(patched, /widgetMaxLines: 12/);
  assert.match(patched, /shortcut: ctrl\+m/, "untouched keys survive");
  assert.match(patched, /dir: plans/);

  await expectNekError(
    async () =>
      await harness.api.patchNekYaml(LOCAL, "global", { unknown: { a: 1 } } as never, {
        revision: (await harness.api.readNekYaml(LOCAL, "global")).revision,
      }),
    "validation",
  );
});

test("instructions and resources reflect the agent dir", async () => {
  const harness = createHarness({
    localFiles: {
      [join(AGENT_DIR, "AGENTS.md")]: "global rules\n",
      [join(AGENT_DIR, "skills", "pdf", "SKILL.md")]:
        "---\nname: pdf\ndescription: read PDFs\n---\n",
      [join(AGENT_DIR, "prompts", "review.md")]: "---\ndescription: review staged changes\n---\n",
      [join(AGENT_DIR, "extensions", "llama.ts")]: "export {};\n",
    },
  });
  const instructions = await harness.api.readInstructions(LOCAL, "global");
  assert.equal(instructions.content, "global rules\n");
  const write = await harness.api.writeInstructions(LOCAL, "global", "new rules\n", {
    revision: instructions.revision,
  });
  assert.ok(write.revision.length > 0);
  assert.equal(harness.local.files.get(join(AGENT_DIR, "AGENTS.md")), "new rules\n");
  await expectNekError(
    async () =>
      await harness.api.writeInstructions(LOCAL, "global", "other\n", {
        revision: instructions.revision,
      }),
    "conflict",
  );

  const resources = await harness.api.listResources(LOCAL, PROJECT);
  assert.deepEqual(resources.skills, [
    { name: "pdf", path: join(AGENT_DIR, "skills", "pdf", "SKILL.md"), description: "read PDFs" },
  ]);
  assert.deepEqual(resources.prompts, [
    {
      name: "review",
      path: join(AGENT_DIR, "prompts", "review.md"),
      description: "review staged changes",
    },
  ]);
  assert.deepEqual(resources.extensions, [
    { name: "llama", path: join(AGENT_DIR, "extensions", "llama.ts") },
  ]);
  assert.equal(resources.directories.agentDir, AGENT_DIR);
  assert.equal(resources.directories.projectDir, PROJECT_DIR);
});

test("a disconnected target fails with not_connected and model catalog comes from the control process", async () => {
  const harness = createHarness();
  const models = await harness.api.listAvailableModels(LOCAL);
  assert.equal(models.length, 1);
  assert.equal(models[0]?.id, "claude-sonnet-4-5");
  assert.deepEqual(
    models[0]?.thinkingLevels.includes("off"),
    false,
    "thinkingLevelMap null disables a level",
  );
  assert.equal(models[0]?.contextWindow, 200_000);

  harness.disconnect();
  const error = await expectNekError(
    async () => await harness.api.readModelsConfig(LOCAL),
    "not_connected",
  );
  assert.match(error.message, /not connected/);
});

test("an executor without a lock is reported instead of writing unlocked", async () => {
  const harness = createHarness({ localFiles: { [SETTINGS_PATH]: "{}" } });
  const read = await harness.api.readSettings(LOCAL, "global");
  const unlocked = { ...harness.local, lock: undefined };
  // 直接调用底层文档函数，验证"没有锁就不写"。
  const { patchSettingsDocument } = await import("../src/nek-config-api/settingsDocument.js");
  const error = await expectNekError(
    async () =>
      await patchSettingsDocument({
        executor: unlocked,
        path: SETTINGS_PATH,
        patch: { defaultModel: "a/b" },
        expectedRevision: read.revision,
      }),
    "io",
  );
  assert.match(error.message, /no settings lock/);
  assert.equal(harness.local.files.get(SETTINGS_PATH), "{}");
});

test("model CRUD keeps order, rejects duplicates and appends unlisted models on reorder", async () => {
  const harness = createHarness({
    localFiles: {
      [MODELS_PATH]: modelsFile(`{
    "local": {
      "api": "openai-completions",
      "baseUrl": "http://a",
      "models": [{ "id": "a" }, { "id": "b" }, { "id": "c" }]
    }
  }`),
    },
  });
  let view = await harness.api.readModelsConfig(LOCAL);
  assert.deepEqual(
    view.providers[0]?.models.map((model) => model.id),
    ["a", "b", "c"],
  );

  await harness.api.saveModel(
    LOCAL,
    "local",
    { id: "b", name: "B alias" },
    {
      revision: view.revision,
      previousId: "b",
    },
  );
  await harness.api.addModels(LOCAL, "local", [{ id: "d", contextWindow: 200_000 }], {
    revision: (await harness.api.readModelsConfig(LOCAL)).revision,
  });
  await expectNekError(
    async () =>
      await harness.api.addModels(LOCAL, "local", [{ id: "a" }], {
        revision: (await harness.api.readModelsConfig(LOCAL)).revision,
      }),
    "validation",
  );

  view = await harness.api.readModelsConfig(LOCAL);
  assert.deepEqual(
    view.providers[0]?.models.map((model) => model.id),
    ["a", "b", "c", "d"],
  );
  assert.equal(view.providers[0]?.models[1]?.name, "B alias");

  // 只列出 c、a：未列出的 b、d 追加到末尾。
  await harness.api.reorderModels(LOCAL, "local", ["c", "a"], { revision: view.revision });
  view = await harness.api.readModelsConfig(LOCAL);
  assert.deepEqual(
    view.providers[0]?.models.map((model) => model.id),
    ["c", "a", "b", "d"],
  );
  await expectNekError(
    async () =>
      await harness.api.reorderModels(LOCAL, "local", ["missing"], { revision: view.revision }),
    "validation",
  );

  await harness.api.deleteModel(LOCAL, "local", "a", { revision: view.revision });
  await expectNekError(
    async () =>
      await harness.api.deleteModel(LOCAL, "local", "a", {
        revision: (await harness.api.readModelsConfig(LOCAL)).revision,
      }),
    "validation",
  );
  view = await harness.api.readModelsConfig(LOCAL);
  assert.deepEqual(
    view.providers[0]?.models.map((model) => model.id),
    ["c", "b", "d"],
  );

  // 新建服务商要求 ID 合法且唯一
  await expectNekError(
    async () =>
      await harness.api.saveProvider(
        LOCAL,
        { id: "Bad ID", api: "openai-completions", baseUrl: "http://x", models: [] },
        { revision: view.revision, isNew: true },
      ),
    "validation",
  );
  await expectNekError(
    async () =>
      await harness.api.saveProvider(
        LOCAL,
        { id: "local", api: "openai-completions", baseUrl: "http://x", models: [] },
        { revision: view.revision, isNew: true },
      ),
    "validation",
  );
});

test("project trust, config validation and web search test use the control process", async () => {
  const harness = createHarness();
  const trust = await harness.api.getProjectTrust(LOCAL, PROJECT);
  assert.equal(trust.cwd, PROJECT);
  assert.equal(trust.trusted, null);
  await harness.api.setProjectTrust(LOCAL, PROJECT, true);
  assert.deepEqual(await harness.api.validate(LOCAL, PROJECT), []);
  assert.deepEqual(await harness.api.testWebSearch(LOCAL, "nek"), {
    ok: true,
    latencyMs: 12,
    resultCount: 3,
  });
  const commands = harness.control.commands.map((command) => command.type);
  assert.deepEqual(commands, [
    "get_project_trust",
    "set_project_trust",
    "validate_config",
    "test_web_search",
  ]);

  // 目标表来自 host，未连接的主机状态可见
  const targets = await harness.api.listTargets();
  assert.equal(targets.length, 2);
  assert.equal(targets[1]?.target.kind, "remote");
  assert.equal(targets[1]?.connected, true);
});

test("model helpers take the project cwd explicitly instead of a remembered hint", async () => {
  const projectPresetPath = join(PROJECT_DIR, "agents", "project-reviewer.md");
  const harness = createHarness({
    localFiles: {
      [MODELS_PATH]: modelsFile(`{
    "local": { "api": "openai-completions", "baseUrl": "http://a", "models": [] }
  }`),
      [PRESET_PATH]:
        "---\nname: reviewer\ndescription: Reviews diffs\nmodel: local/one\n---\n\nGlobal.\n",
      [projectPresetPath]:
        "---\nname: project-reviewer\ndescription: Project reviews\nmodel: local/two\n---\n\nProject.\n",
    },
  });

  // 先看一次项目目录：不能因此"记住" cwd，后续不带 cwd 的调用仍只看全局。
  const withCwd = await harness.api.getProviderReferences(LOCAL, "local", PROJECT);
  assert.deepEqual(
    withCwd.agentPresets.map((entry) => entry.name),
    ["reviewer", "project-reviewer"],
  );
  const withoutCwd = await harness.api.getProviderReferences(LOCAL, "local");
  assert.deepEqual(
    withoutCwd.agentPresets.map((entry) => entry.name),
    ["reviewer"],
  );

  // 改名时按传入的 cwd 重写项目预设里的引用
  const view = await harness.api.readModelsConfig(LOCAL, PROJECT);
  await harness.api.renameProvider(LOCAL, "local", "local2", {
    revision: view.revision,
    cwd: PROJECT,
  });
  assert.match(harness.local.files.get(projectPresetPath) ?? "", /model: local2\/two/);
  assert.match(harness.local.files.get(PRESET_PATH) ?? "", /model: local2\/one/);
});

test("provider api keys: {remove:true} deletes, an empty string is a validation error", async () => {
  const harness = createHarness({
    localFiles: {
      [MODELS_PATH]: modelsFile(`{
    "local": { "api": "openai-completions", "baseUrl": "http://a", "apiKey": "sk-existing", "models": [] }
  }`),
    },
  });
  const view = await harness.api.readModelsConfig(LOCAL);
  const provider = view.providers[0];
  assert.ok(provider);
  assert.deepEqual(provider.apiKey, { kind: "literal", masked: "••••ting" });

  const empty = await expectNekError(
    async () =>
      await harness.api.saveProvider(
        LOCAL,
        { ...toWrite(provider), apiKey: "" } as NekProviderWrite,
        { revision: view.revision, isNew: false },
      ),
    "validation",
  );
  assert.ok(empty.fieldErrors?.apiKey);

  await harness.api.saveProvider(
    LOCAL,
    { ...toWrite(provider), apiKey: { remove: true } } as NekProviderWrite,
    { revision: view.revision, isNew: false },
  );
  const after = readJson(harness.local, MODELS_PATH) as {
    providers: Record<string, { apiKey?: string }>;
  };
  assert.equal(after.providers.local?.apiKey, undefined);
  assert.equal((await harness.api.readModelsConfig(LOCAL)).providers[0]?.apiKey.kind, "none");
});

test("agent presets report broken files as diagnostics with a directory revision", async () => {
  const brokenPath = join(AGENT_DIR, "agents", "broken.md");
  const harness = createHarness({
    localFiles: {
      [PRESET_PATH]: "---\nname: reviewer\ndescription: Reviews diffs\n---\n\nFine.\n",
      [brokenPath]: "---\nname: [unterminated\n---\n\nBroken.\n",
    },
  });
  const view = await harness.api.listAgentPresets(LOCAL);
  assert.deepEqual(
    view.entries.map((entry) => entry.preset.name),
    ["generalPurpose", "explorer", "reviewer"],
  );
  assert.equal(view.diagnostics.length, 1);
  assert.equal(view.diagnostics[0]?.file, brokenPath);
  assert.equal(view.diagnostics[0]?.severity, "error");
  assert.ok(view.revision.length > 0);

  // revision 只随目录内容变化
  assert.equal((await harness.api.listAgentPresets(LOCAL)).revision, view.revision);
  harness.local.files.set(brokenPath, "---\nname: fixed\ndescription: Now valid\n---\n\nFixed.\n");
  const fixed = await harness.api.listAgentPresets(LOCAL);
  assert.notEqual(fixed.revision, view.revision);
  assert.equal(fixed.diagnostics.length, 0);
  assert.ok(fixed.entries.some((entry) => entry.preset.name === "fixed"));
});

test("builtin tools come from the nek control process", async () => {
  const harness = createHarness();
  const tools = await harness.api.listBuiltinTools(LOCAL);
  assert.deepEqual(
    harness.control.commands.map((command) => command.type),
    ["list_builtin_tools"],
  );
  assert.deepEqual(tools, harness.control.builtinTools);
  assert.equal(tools.find((tool) => tool.name === "powershell")?.defaultActive, false);

  // 清单完全由 nek 决定：换一份返回值就换一份结果，宿主没有硬编码镜像。
  harness.control.builtinTools = [{ name: "webfetch", defaultActive: false }];
  assert.deepEqual(await harness.api.listBuiltinTools(REMOTE), [
    { name: "webfetch", defaultActive: false },
  ]);
});

test("mcp entries carry the file they come from", async () => {
  const harness = createHarness({
    localFiles: {
      [MCP_PATH]: JSON.stringify({ mcpServers: { filesystem: { command: "npx" } } }),
      [PROJECT_MCP_PATH]: JSON.stringify({ mcpServers: { docs: { url: "https://docs" } } }),
    },
  });
  const global = await harness.api.readMcpConfig(LOCAL, "global");
  assert.equal(global.servers[0]?.path, MCP_PATH);
  const project = await harness.api.readMcpConfig(LOCAL, "project", PROJECT);
  assert.equal(project.servers[0]?.path, PROJECT_MCP_PATH);
});

test("fetching models and testing a provider send the provider id plus draft overrides", async () => {
  const harness = createHarness();

  await harness.api.fetchProviderModels(LOCAL, { providerId: "local" });
  assert.deepEqual(harness.control.commands.at(-1), {
    type: "fetch_provider_models",
    provider: "local",
  });

  // 草稿只带端点：没写的密钥/请求头由 nek 沿用已保存的值，宿主不再读 models.json。
  await harness.api.fetchProviderModels(LOCAL, {
    providerId: "local",
    draft: { api: "anthropic-messages", baseUrl: "http://draft" },
  });
  assert.deepEqual(harness.control.commands.at(-1), {
    type: "fetch_provider_models",
    provider: "local",
    overrides: { api: "anthropic-messages", baseUrl: "http://draft" },
  });

  const tested = await harness.api.testProvider(
    LOCAL,
    {
      providerId: "local",
      draft: {
        api: "openai-completions",
        baseUrl: "http://draft",
        apiKey: "$DRAFT_KEY",
        headers: { "x-draft": "1" },
        authHeader: false,
      },
    },
    "m1",
  );
  assert.deepEqual(tested, { ok: true, latencyMs: 7 });
  assert.deepEqual(harness.control.commands.at(-1), {
    type: "test_provider",
    modelId: "m1",
    provider: "local",
    overrides: {
      api: "openai-completions",
      baseUrl: "http://draft",
      apiKey: "$DRAFT_KEY",
      headers: { "x-draft": "1" },
      authHeader: false,
    },
  });

  // 未知 provider 交给 nek 判定（它回 "Unknown provider: <id>"），宿主不预读配置。
  await harness.api.fetchProviderModels(REMOTE, {
    providerId: "missing",
    draft: { api: "openai-completions", baseUrl: "http://draft" },
  });
  assert.equal(harness.control.commands.at(-1)?.provider, "missing");

  // 空 providerId 仍然本地拒绝：不必为一次拼错的调用来回起控制进程。
  await expectNekError(
    async () => await harness.api.fetchProviderModels(LOCAL, { providerId: "" }),
    "validation",
  );
});

test("the local target reports the machine host name", async () => {
  const host = createLocalNekConfigTargetHost({
    executor: createMemoryNekConfigHostExecutor({ home: HOME, agentDir: AGENT_DIR, files: {} }),
    locator: {
      locate: async () => Promise.reject(new NekLocatorError("not_found", "missing")),
    } as never,
  });
  const [local] = await host.listTargets();
  assert.equal(local?.hostname, os.hostname());
  assert.equal(local?.nek.state, "not_installed");
});
