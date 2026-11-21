import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createNekModelFactsSource } from "../src/model-provider/nekModelFacts.js";
import { createNekModelSelectionService } from "../src/model-provider/nekModelSelectionService.js";
import {
  AGENT_DIR,
  LOCAL,
  PROJECT,
  PROJECT_DIR,
  REMOTE,
  REMOTE_AGENT_DIR,
  createHarness,
  expectNekError,
  FakeControlClient,
  readJson,
} from "./nekConfigApiHarness.js";
import { catalogModel, createFakeFactsApi } from "./nekModelFactsFixture.js";

const modelsPath = join(AGENT_DIR, "models.json");
const settingsPath = join(AGENT_DIR, "settings.json");
const projectSettingsPath = join(PROJECT_DIR, "settings.json");
const remoteSettingsPath = join(REMOTE_AGENT_DIR, "settings.json");
const gateway = { api: "openai-completions", baseUrl: "https://fixture.invalid/v1" };
const modelFile = (...ids: string[]) =>
  JSON.stringify({ providers: { CPA: { ...gateway, models: ids.map((id) => ({ id })) } } });
const settingsFile = (enabledModels: string[]) =>
  JSON.stringify({ enabledModels, keep: { unknown: true } });

function fixture(patterns?: string[], project?: string[], matched = true) {
  const h = createHarness({
    localFiles: {
      [modelsPath]: modelFile("old"),
      ...(patterns ? { [settingsPath]: settingsFile(patterns) } : {}),
      ...(project ? { [projectSettingsPath]: settingsFile(project) } : {}),
    },
  });
  h.control.readModelScope = (cwd) => {
    const current = scopeOf(
      h,
      cwd && h.control.projectTrusted && project ? projectSettingsPath : settingsPath,
    );
    return {
      patterns: current,
      models: matched ? [{ provider: "CPA", id: "old" }] : [],
      diagnostics: [],
    };
  };
  return h;
}

function scopeOf(harness: ReturnType<typeof fixture>, path = settingsPath) {
  return (readJson(harness.local, path) as { enabledModels: string[] }).enabledModels;
}

test("the scope RPC is routed to the selected machine and workspace", async (t) => {
  const h = createHarness();
  t.after(() => h.api.dispose());
  const local = h.control;
  local.modelScope = {
    patterns: ["CPA/local"],
    models: [{ provider: "CPA", id: "local" }],
    diagnostics: [],
  };
  assert.deepEqual(await h.api.getModelScope(LOCAL), local.modelScope);
  const remote = new FakeControlClient();
  remote.modelScope = {
    patterns: ["other/remote:high"],
    models: [{ provider: "other", id: "remote", thinkingLevel: "high" }],
    diagnostics: [],
  };
  h.useControl(remote);
  assert.deepEqual(await h.api.getModelScope(REMOTE, "/remote/repo"), remote.modelScope);
  assert.deepEqual(local.commands, [{ type: "get_model_scope" }]);
  assert.deepEqual(remote.commands, [{ type: "get_model_scope", cwd: "/remote/repo" }]);
});

test("selection view preserves RPC order and diagnostics without invalidating an out-of-scope selection", async (t) => {
  const a = catalogModel({ provider: "a", id: "outside" });
  const b = catalogModel({ provider: "b", id: "inside" });
  const c = catalogModel({ provider: "a", id: "also-in" });
  const scope = {
    patterns: ["b/inside", "a/also-in", "no-match"],
    models: [
      { provider: "b", id: "inside" },
      { provider: "a", id: "also-in" },
    ],
    diagnostics: [{ code: "no-match" as const, pattern: "no-match", message: "No matching model" }],
  };
  const api = createFakeFactsApi({
    available: [a, b, c],
    catalog: [a, b, c],
    modelScopeByCwd: { "/repo": scope },
  });
  const service = createNekModelSelectionService({
    facts: createNekModelFactsSource(api, { target: REMOTE }),
  });
  t.after(() => service.dispose());
  const all = await service.getView();
  assert.deepEqual(all.scope.patterns, []);
  const selection = { providerId: "a", modelId: "outside", options: { reasoningLevel: "off" } };
  const view = await service.getView({ workspacePath: "/repo", selection });
  assert.deepEqual(view.scope, scope);
  assert.deepEqual(view.effectiveSelection, selection);
  assert.equal(view.selectionIssue, undefined);
  assert.deepEqual(view.providers, all.providers);
  assert.equal(view.revision, all.revision);
  assert.deepEqual(
    api.calls
      .filter(({ method }) => method === "getModelScope")
      .map(({ target, cwd }) => [target, cwd]),
    [
      [REMOTE, undefined],
      [REMOTE, "/repo"],
    ],
  );
});

test("scope RPC failure rejects the model view rather than widening the menu", async (t) => {
  const model = catalogModel({ provider: "CPA", id: "old" });
  const api = createFakeFactsApi({
    available: [model],
    catalog: [model],
    scopeError: new Error("scope RPC failed"),
  });
  const service = createNekModelSelectionService({ facts: createNekModelFactsSource(api) });
  t.after(() => service.dispose());
  await assert.rejects(service.getView(), /get_model_scope.*scope RPC failed/);
});

test("manual, batch/import, fetched and inline provider models append exact ids without duplicates", async (t) => {
  const h = fixture(["CPA/old", "cpa/manual:high"]);
  t.after(() => h.api.dispose());
  const revision = () => h.api.readModelsConfig(LOCAL);
  await h.api.saveModel(
    LOCAL,
    "CPA",
    { id: "manual" },
    { ...(await revision()), defaultThinkingLevel: "low" },
  );
  await h.api.saveModel(
    LOCAL,
    "CPA",
    { id: "manual-with-level" },
    { ...(await revision()), defaultThinkingLevel: "off" },
  );
  await h.api.addModels(
    LOCAL,
    "CPA",
    [{ id: "imported-a" }, { id: "vendor/imported-b" }],
    await revision(),
  );
  const fetched = await h.api.fetchProviderModels(LOCAL, { providerId: "CPA" });
  assert.ok(fetched.ok);
  await h.api.addModels(
    LOCAL,
    "CPA",
    fetched.models.map(({ id }) => ({ id })),
    await revision(),
  );
  await h.api.saveProvider(
    LOCAL,
    { ...gateway, id: "new", models: [{ id: "inline" }] },
    { ...(await revision()), isNew: true },
  );
  await h.api.saveProvider(
    LOCAL,
    { ...gateway, id: "new", models: [{ id: "inline" }, { id: "in-provider-edit" }] },
    { ...(await revision()), isNew: false },
  );
  assert.deepEqual(scopeOf(h), [
    "CPA/old",
    "cpa/manual:high",
    "CPA/manual-with-level",
    "CPA/imported-a",
    "CPA/vendor/imported-b",
    "CPA/draft-model",
    "new/inline",
    "new/in-provider-edit",
  ]);
  const settings = await h.api.readSettings(LOCAL, "global");
  assert.deepEqual(settings.values.modelThinkingLevels, {
    "CPA/manual": "low",
    "CPA/manual-with-level": "off",
  });
  assert.deepEqual((readJson(h.local, settingsPath) as { keep: unknown }).keep, { unknown: true });
});

for (const scenario of [
  {
    name: "trusted project with a scope",
    project: ["CPA/old:high"],
    trusted: true,
    matched: true,
    append: "project",
  },
  {
    name: "trusted project with empty scope",
    project: [],
    trusted: true,
    matched: false,
    append: "neither",
  },
  {
    name: "trusted project with no matching models",
    project: ["missing/*"],
    trusted: true,
    matched: false,
    append: "neither",
  },
  {
    name: "untrusted project",
    project: ["project/original"],
    trusted: false,
    matched: true,
    append: "global",
  },
] as const) {
  test(`new model respects ${scenario.name}`, async (t) => {
    const project = [...scenario.project];
    const h = fixture(["CPA/old"], project, scenario.matched);
    t.after(() => h.api.dispose());
    h.control.projectTrusted = scenario.trusted;
    await h.api.addModels(LOCAL, "CPA", [{ id: "new" }], {
      ...(await h.api.readModelsConfig(LOCAL)),
      cwd: PROJECT,
    });
    assert.deepEqual(
      scopeOf(h),
      scenario.append === "global" ? ["CPA/old", "CPA/new"] : ["CPA/old"],
    );
    assert.deepEqual(
      scopeOf(h, projectSettingsPath),
      scenario.append === "project" ? [...project, "CPA/new"] : project,
    );
  });
}

test("an absent or empty scope stays unrestricted when adding models", async (t) => {
  for (const patterns of [undefined, []]) {
    const h = fixture(patterns);
    t.after(() => h.api.dispose());
    await h.api.addModels(LOCAL, "CPA", [{ id: "new" }], await h.api.readModelsConfig(LOCAL));
    assert.equal(h.local.files.get(settingsPath), patterns ? settingsFile(patterns) : undefined);
  }
});

test("new models do not expand a scope which matches nothing before saving", async (t) => {
  const patterns = ["CPA/new", "missing/*"];
  const h = fixture(patterns, undefined, false);
  t.after(() => h.api.dispose());
  const options = await h.api.readModelsConfig(LOCAL);
  await h.api.addModels(LOCAL, "CPA", [{ id: "new" }, { id: "not-in-range" }], options);
  assert.equal(h.local.files.get(settingsPath), settingsFile(patterns));
  assert.deepEqual(
    (await h.api.readModelsConfig(LOCAL)).providers[0]?.models.map(({ id }) => id),
    ["old", "new", "not-in-range"],
  );
  assert.deepEqual(h.control.commands, [{ type: "get_model_scope" }]);
});

test("an RPC failure or a stale scope cannot silently save a configured model addition", async (t) => {
  const h = fixture(["CPA/old"]);
  t.after(() => h.api.dispose());
  const options = await h.api.readModelsConfig(LOCAL);
  const add = () => h.api.addModels(LOCAL, "CPA", [{ id: "new" }], options);
  h.control.readModelScope = () => {
    throw new Error("scope read failed");
  };
  await assert.rejects(add(), /scope read failed/);
  h.control.readModelScope = () => ({
    patterns: ["other/old"],
    models: [{ provider: "other", id: "old" }],
    diagnostics: [],
  });
  await expectNekError(add, "conflict");
  assert.equal(h.local.writes.length, 0);
  assert.equal(h.local.files.get(settingsPath), settingsFile(["CPA/old"]));
});

test("model/provider rename and delete rewrite definite scope references in both documents", async (t) => {
  const h = fixture(["cpa/old:high", "CPA/*", "other/model"], ["CPA/old:low", "other/model"]);
  t.after(() => h.api.dispose());
  h.control.projectTrusted = true;
  const options = async () => ({ ...(await h.api.readModelsConfig(LOCAL)), cwd: PROJECT });
  await h.api.saveModel(
    LOCAL,
    "CPA",
    { id: "vendor/new" },
    { ...(await options()), previousId: "old" },
  );
  assert.deepEqual(scopeOf(h), ["CPA/vendor/new:high", "CPA/*", "other/model"]);
  assert.deepEqual(scopeOf(h, projectSettingsPath), ["CPA/vendor/new:low", "other/model"]);
  await h.api.renameProvider(LOCAL, "CPA", "replacement", await options());
  assert.deepEqual(scopeOf(h), ["replacement/vendor/new:high", "replacement/*", "other/model"]);
  await h.api.deleteModel(LOCAL, "replacement", "vendor/new", await options());
  assert.deepEqual(scopeOf(h), ["replacement/*", "other/model"]);
  assert.deepEqual(scopeOf(h, projectSettingsPath), ["other/model"]);
  await h.api.deleteProvider(LOCAL, "replacement", await options());
  assert.deepEqual(scopeOf(h), ["other/model"]);
});

for (const matched of [true, false]) {
  test(`provider copy only appends to a destination scope with matches (${matched})`, async (t) => {
    const h = createHarness({
      localFiles: {
        [modelsPath]: modelFile("old", "new"),
        [settingsPath]: settingsFile(["CPA/old"]),
      },
      remoteFiles: {
        [remoteSettingsPath]: settingsFile(["remote/global"]),
        [projectSettingsPath]: settingsFile(["remote/project"]),
      },
    });
    t.after(() => h.api.dispose());
    h.control.projectTrusted = true;
    h.control.readModelScope = (cwd) => {
      assert.equal(cwd, PROJECT);
      return {
        patterns: ["remote/project"],
        models: matched ? [{ provider: "remote", id: "project" }] : [],
        diagnostics: [],
      };
    };
    const selection = {
      providers: ["CPA"],
      logins: [],
      mcpServers: [],
      defaults: false,
      compaction: false,
    };
    const result = await h.api.copy(LOCAL, REMOTE, { ...selection, targetCwd: PROJECT }, {});
    assert.deepEqual(result.items, [{ key: "provider:CPA", status: "copied" }]);
    assert.deepEqual(
      readJson(h.remote, projectSettingsPath),
      JSON.parse(
        settingsFile(matched ? ["remote/project", "CPA/old", "CPA/new"] : ["remote/project"]),
      ),
    );
    assert.equal(h.remote.files.get(remoteSettingsPath), settingsFile(["remote/global"]));
    assert.deepEqual(scopeOf(h), ["CPA/old"]);

    const withDefaults = await h.api.copy(
      LOCAL,
      REMOTE,
      { ...selection, defaults: true },
      { "defaults:defaults": "overwrite" },
    );
    assert.equal(
      withDefaults.items.find(({ key }) => key === "defaults:defaults")?.status,
      "copied",
    );
    assert.deepEqual(readJson(h.remote, remoteSettingsPath), JSON.parse(settingsFile(["CPA/old"])));
  });
}

test("a conflicting settings lock prevents writing models and the same model write can retry", async (t) => {
  const h = fixture(["CPA/old"]);
  t.after(() => h.api.dispose());
  const options = await h.api.readModelsConfig(LOCAL);
  const lock = h.local.lock!;
  const runLocked = lock.runLocked;
  lock.runLocked = (path, critical) => {
    lock.runLocked = runLocked;
    h.local.setFile(
      path,
      JSON.stringify({ enabledModels: ["CPA/old", "other/updated"], fresh: true }),
    );
    return runLocked(path, critical);
  };
  const add = () => h.api.addModels(LOCAL, "CPA", [{ id: "new" }], options);
  await expectNekError(add, "conflict");
  assert.equal(h.local.writes.length, 0);
  await add();
  assert.deepEqual(readJson(h.local, settingsPath), {
    enabledModels: ["CPA/old", "other/updated", "CPA/new"],
    fresh: true,
  });
});

test("a failed model write reports the saved scope and repeating the operation does not duplicate entries", async (t) => {
  const h = fixture(["CPA/old"]);
  t.after(() => h.api.dispose());
  const options = await h.api.readModelsConfig(LOCAL);
  const write = h.local.writeFileAtomic;
  h.local.writeFileAtomic = async (path, content) => {
    h.local.writeFileAtomic = write;
    if (path === modelsPath) throw new Error("model write failed");
    await write(path, content);
  };
  const add = () => h.api.addModels(LOCAL, "CPA", [{ id: "new" }], options);
  await assert.rejects(add(), /Model settings were saved.*model write failed/);
  await add();
  assert.deepEqual(scopeOf(h), ["CPA/old", "CPA/new"]);
});

test("scope editor compares displayed patterns and preserves an explicit empty project override", async (t) => {
  const h = fixture(["CPA/old"], ["CPA/new"]);
  t.after(() => h.api.dispose());
  h.control.projectTrusted = true;
  await expectNekError(
    () => h.api.saveModelScope(LOCAL, [], { cwd: PROJECT, expectedPatterns: ["CPA/old"] }),
    "conflict",
  );
  await h.api.saveModelScope(LOCAL, [], { cwd: PROJECT, expectedPatterns: ["CPA/new"] });
  assert.deepEqual(scopeOf(h, projectSettingsPath), []);
  assert.deepEqual(scopeOf(h), ["CPA/old"]);
});
