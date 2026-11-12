import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  AGENT_DIR,
  REMOTE_AGENT_DIR,
  LOCAL,
  REMOTE,
  createHarness,
  expectNekError,
  toWrite,
} from "./nekConfigApiHarness.js";

const gateway = {
  baseUrl: "https://gateway.invalid/v1",
  apiKey: "fixture-key",
  models: [{ id: "first", api: "openai-completions" }],
};
const file = (provider: object) => JSON.stringify({ providers: { CPA: provider } });

for (const target of [LOCAL, REMOTE]) {
  test(`endpoint write admission on ${target.kind}: missing API never reaches disk or reload`, async () => {
    const path = join(target.kind === "local" ? AGENT_DIR : REMOTE_AGENT_DIR, "models.json");
    const harness = createHarness({
      [target.kind === "local" ? "localFiles" : "remoteFiles"]: { [path]: file(gateway) },
      autoReload: true,
    });
    try {
      const executor = target.kind === "local" ? harness.local : harness.remote;
      const initial = await harness.api.readModelsConfig(target);
      const before = executor.files.get(path);
      await harness.api.listAvailableModels(target);
      const requests = harness.control.commands.length;
      for (const save of [
        () => harness.api.addModels(target, "CPA", [{ id: "gemini-4-carbon" }], initial),
        () => harness.api.saveModel(target, "CPA", { id: "first" }, initial),
      ]) {
        const error = await expectNekError(save, "validation");
        assert.match(error.message, /requires "api"/);
        assert.equal(executor.files.get(path), before);
        assert.equal(executor.writes.length, 0);
        assert.equal(harness.control.commands.length, requests);
      }
      await harness.api.addModels(
        target,
        "CPA",
        [{ id: "gemini-4-carbon", api: "google-generative-ai" }],
        initial,
      );
      const added = await harness.api.readModelsConfig(target);
      await harness.api.reorderModels(target, "CPA", ["gemini-4-carbon", "first"], added);
      assert.deepEqual(
        (await harness.api.readModelsConfig(target)).providers[0]?.models.map((model) => model.api),
        ["google-generative-ai", "openai-completions"],
      );
    } finally {
      harness.api.dispose();
    }
  });
}

test("existing uppercase provider is editable; removing inherited API is rejected atomically", async () => {
  const path = join(AGENT_DIR, "models.json");
  const harness = createHarness({
    localFiles: {
      [path]: file({ ...gateway, api: "openai-responses", models: [{ id: "inherits" }] }),
    },
  });
  try {
    const initial = await harness.api.readModelsConfig(LOCAL);
    const provider = initial.providers[0]!;
    await harness.api.saveProvider(LOCAL, toWrite(provider, { name: "Edited CPA" }), {
      ...initial,
      isNew: false,
    });
    const updated = await harness.api.readModelsConfig(LOCAL);
    assert.equal(updated.providers[0]?.id, "CPA");
    assert.equal(updated.providers[0]?.name, "Edited CPA");
    const before = harness.local.files.get(path);
    await expectNekError(
      () =>
        harness.api.saveProvider(LOCAL, toWrite(updated.providers[0]!, { api: "" }), {
          ...updated,
          isNew: false,
        }),
      "validation",
    );
    assert.equal(harness.local.files.get(path), before);
    assert.match(before!, /fixture-key/);
  } finally {
    harness.api.dispose();
  }
});

test("incomplete legacy models can be repaired individually, but cannot be reordered into different defaults", async () => {
  const path = join(AGENT_DIR, "models.json");
  const harness = createHarness({
    localFiles: {
      [path]: file({ ...gateway, models: [...gateway.models, { id: "a" }, { id: "b" }] }),
    },
  });
  try {
    const initial = await harness.api.readModelsConfig(LOCAL);
    await expectNekError(
      () => harness.api.reorderModels(LOCAL, "CPA", ["a", "first", "b"], initial),
      "validation",
    );
    await harness.api.saveModel(
      LOCAL,
      "CPA",
      { id: "a", api: "anthropic-messages", baseUrl: "https://gateway.invalid" },
      initial,
    );
    const halfway = await harness.api.readModelsConfig(LOCAL);
    assert.equal(halfway.diagnostics.length, 1);
    assert.match(halfway.diagnostics[0]!.message, /"b"/);
    await harness.api.saveModel(LOCAL, "CPA", { id: "b", api: "openai-responses" }, halfway);
    assert.deepEqual((await harness.api.readModelsConfig(LOCAL)).diagnostics, []);
  } finally {
    harness.api.dispose();
  }
});

test("base URL, blank endpoints and invalid token limits are rejected before writing", async () => {
  const path = join(AGENT_DIR, "models.json");
  const harness = createHarness({ localFiles: { [path]: file(gateway) } });
  try {
    const initial = await harness.api.readModelsConfig(LOCAL);
    for (const patch of [
      { api: "   " },
      { baseUrl: " " },
      { contextWindow: 0 },
      { maxTokens: -1 },
    ]) {
      await expectNekError(
        () =>
          harness.api.saveModel(
            LOCAL,
            "CPA",
            { id: "first", api: "openai-completions", ...patch },
            initial,
          ),
        "validation",
      );
    }
    await expectNekError(
      () =>
        harness.api.saveProvider(LOCAL, toWrite(initial.providers[0]!, { baseUrl: undefined }), {
          ...initial,
          isNew: false,
        }),
      "validation",
    );
    assert.equal(harness.local.writes.length, 0);
  } finally {
    harness.api.dispose();
  }
});

test("built-in provider defaults remain supported and unknown model fields roundtrip", async () => {
  const harness = createHarness();
  try {
    const initial = await harness.api.readModelsConfig(LOCAL);
    await harness.api.saveProvider(
      LOCAL,
      { id: "anthropic", models: [{ id: "custom", extra: { opaque: { keep: true } } }] },
      { ...initial, isNew: true },
    );
    const saved = await harness.api.readModelsConfig(LOCAL);
    assert.deepEqual(saved.diagnostics, []);
    assert.deepEqual(saved.providers[0]?.models[0]?.extra, { opaque: { keep: true } });
  } finally {
    harness.api.dispose();
  }
});

test("copy refuses an ambiguous provider without changing the remote file", async () => {
  const harness = createHarness({
    localFiles: {
      [join(AGENT_DIR, "models.json")]: file({ ...gateway, models: [{ id: "no-api" }] }),
    },
  });
  try {
    const result = await harness.api.copy(
      LOCAL,
      REMOTE,
      { providers: ["CPA"], logins: [], mcpServers: [], defaults: false, compaction: false },
      {},
    );
    assert.equal(result.items[0]?.status, "failed");
    assert.match(result.items[0]?.error ?? "", /requires "api"/);
    assert.equal(harness.remote.writes.length, 0);
  } finally {
    harness.api.dispose();
  }
});
