import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { readModelsSnapshot } from "../src/nek-config-api/modelsDocument.js";
import {
  AGENT_DIR,
  LOCAL,
  createHarness,
  expectNekError,
  readJson,
} from "./nekConfigApiHarness.js";

const MODELS_PATH = join(AGENT_DIR, "models.json");
const provider = {
  api: "openai-completions" as const,
  baseUrl: "https://proxy.example.test/v1",
  models: [{ id: "vendor/model" }],
};

for (const id of ["CPA", "My_Proxy", "vendor.ai", "中转", "My Proxy"]) {
  test(`NM-1 creates and renames a provider to ${id} without changing its ID`, async (t) => {
    const { api, local } = createHarness();
    t.after(() => api.dispose());
    const view = await api.readModelsConfig(LOCAL);
    const created = await api.saveProvider(LOCAL, { ...provider, id }, { ...view, isNew: true });
    assert.equal((await api.readModelsConfig(LOCAL)).providers[0]?.id, id);
    const moved = await api.renameProvider(LOCAL, id, "temporary", created);
    assert.equal((await api.previewProviderRename(LOCAL, "temporary", id)).to, id);
    await api.renameProvider(LOCAL, "temporary", id, moved);
    assert.deepEqual(readJson(local, MODELS_PATH), { providers: { [id]: provider } });
  });
}

for (const id of ["__proto__", "constructor", "prototype"]) {
  test(`NM-1 ${id} is a literal provider key through create, edit, rename and delete`, async (t) => {
    const { api, local } = createHarness();
    t.after(() => api.dispose());
    const initial = await api.readModelsConfig(LOCAL);
    const created = await api.saveProvider(LOCAL, { ...provider, id }, { ...initial, isNew: true });
    assert.equal((await api.readModelsConfig(LOCAL)).providers[0]?.id, id);
    const changed = { ...provider, name: "Edited" };
    const edited = await api.saveProvider(LOCAL, { ...changed, id }, { ...created, isNew: false });
    const renamed = await api.renameProvider(LOCAL, id, "temporary", edited);
    assert.equal((await api.readModelsConfig(LOCAL)).providers[0]?.id, "temporary");
    const restored = await api.renameProvider(LOCAL, "temporary", id, renamed);
    const snapshot = await readModelsSnapshot(local, MODELS_PATH);
    assert.equal(Object.getPrototypeOf(snapshot.providers), null);
    assert.deepEqual(Object.keys(snapshot.providers), [id]);
    assert.deepEqual(snapshot.providers[id], changed);
    const raw: unknown = JSON.parse(local.files.get(MODELS_PATH)!);
    assert.deepEqual(raw, { providers: { [id]: changed } });
    await api.deleteProvider(LOCAL, id, restored);
    assert.deepEqual((await api.readModelsConfig(LOCAL)).providers, []);
  });
}

test("NM-1 keeps escaped JSONC keys and nested special keys as data without inheriting fields", async (t) => {
  const id = "__proto__";
  const extra = {
    [id]: { apiKey: "fixture-only", nmOwnOnly: true },
    constructor: { prototype: { nmOwnOnly: true } },
    prototype: { marker: "metadata" },
  };
  const raw = `{
    // Keep comments and trailing commas.
    "__proto__": {"nmOwnOnly": true},
    "providers": {"\\u005f_proto__": ${JSON.stringify({ ...provider, ...extra })},},
  }`;
  const { api, local } = createHarness({ localFiles: { [MODELS_PATH]: raw } });
  t.after(() => api.dispose());
  const snapshot = await readModelsSnapshot(local, MODELS_PATH);
  assert.equal(Object.getPrototypeOf(snapshot.data), Object.prototype);
  assert.equal(Object.hasOwn(snapshot.data, id), true);
  assert.equal(snapshot.data.nmOwnOnly, undefined);
  assert.equal(Object.hasOwn(Object.prototype, "nmOwnOnly"), false);
  const view = await api.readModelsConfig(LOCAL);
  assert.equal(view.providers[0]?.id, id);
  assert.deepEqual(view.providers[0]?.apiKey, { kind: "none" });
  assert.deepEqual(view.providers[0]?.extra, extra);
  await api.saveProvider(
    LOCAL,
    { ...provider, id, name: "Changed", extra: view.providers[0]?.extra },
    { ...view, isNew: false },
  );
  assert.match(local.files.get(MODELS_PATH)!, /Keep comments and trailing commas/u);
  const after = (await api.readModelsConfig(LOCAL)).providers[0];
  assert.equal(after?.name, "Changed");
  assert.deepEqual(after?.extra, extra);
  assert.equal(Object.hasOwn(Object.prototype, "nmOwnOnly"), false);
});

test("NM-1 rejects only non-referenceable IDs at create and rename boundaries", async (t) => {
  const { api } = createHarness();
  t.after(() => api.dispose());
  const view = await api.readModelsConfig(LOCAL);
  const created = await api.saveProvider(
    LOCAL,
    { ...provider, id: "source" },
    { ...view, isNew: true },
  );
  for (const [id, expected] of [
    ["", "required"],
    ["\u3000", "required"],
    ["vendor/ai", "slash"],
    [" CPA", "edgeWhitespace"],
    ["CPA\t", "edgeWhitespace"],
  ]) {
    const create = await expectNekError(
      () => api.saveProvider(LOCAL, { ...provider, id }, { ...created, isNew: true }),
      "validation",
    );
    const preview = await expectNekError(
      () => api.previewProviderRename(LOCAL, "source", id),
      "validation",
    );
    const rename = await expectNekError(
      () => api.renameProvider(LOCAL, "source", id, created),
      "validation",
    );
    assert.deepEqual(create.fieldErrors, { id: expected });
    assert.deepEqual(preview.fieldErrors, { to: expected });
    assert.deepEqual(rename.fieldErrors, { to: expected });
    if (expected === "slash") assert.match(rename.message, /provider\/model/u);
  }
  assert.deepEqual(
    (await api.readModelsConfig(LOCAL)).providers.map(({ id }) => id),
    ["source"],
  );
});

test("NM-2 rejects case-folded collisions but allows a case-only rename of the same key", async (t) => {
  const { api } = createHarness({
    localFiles: {
      [MODELS_PATH]: JSON.stringify({ providers: { CPA: provider, Other: provider } }),
    },
  });
  t.after(() => api.dispose());
  const view = await api.readModelsConfig(LOCAL);
  const duplicate = await expectNekError(
    () => api.saveProvider(LOCAL, { ...provider, id: "cpa" }, { ...view, isNew: true }),
    "validation",
  );
  assert.deepEqual(duplicate.fieldErrors, { id: "duplicate" });
  for (const action of [
    () => api.previewProviderRename(LOCAL, "Other", "cpa"),
    () => api.renameProvider(LOCAL, "Other", "cpa", view),
  ]) {
    const error = await expectNekError(action, "validation");
    assert.deepEqual(error.fieldErrors, { to: "duplicate" });
  }
  assert.equal((await api.previewProviderRename(LOCAL, "CPA", "cpa")).to, "cpa");
  await api.renameProvider(LOCAL, "CPA", "cpa", view);
  assert.deepEqual(
    (await api.readModelsConfig(LOCAL)).providers.map(({ id }) => id),
    ["Other", "cpa"],
  );
});
