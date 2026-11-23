import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
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

for (const id of ["CPA", "My_Proxy", "vendor.ai", "中转", "My Proxy", "constructor"]) {
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
