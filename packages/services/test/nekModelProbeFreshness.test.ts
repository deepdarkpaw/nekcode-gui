import assert from "node:assert/strict";
import test from "node:test";
import { runtimeHarness, modelsPath, modelsText, LOCAL } from "./nekModelRuntimeHarness.js";

for (const command of ["fetch_provider_models", "test_provider"] as const) {
  const probe = (h: ReturnType<typeof runtimeHarness>) =>
    command === "fetch_provider_models"
      ? h.configApi.fetchProviderModels(LOCAL, { providerId: "CPA" })
      : h.configApi.testProvider(LOCAL, { providerId: "CPA" }, "old");

  test(`MF1/MF2: ${command} reloads changed config before dispatch, and every probe is a new command`, async () => {
    const h = runtimeHarness();
    try {
      await h.configApi.listAvailableModels(LOCAL);
      const before = h.control.commands.length;
      h.executor.setFile(modelsPath, modelsText("fresh", "http://changed", "openai-responses"));
      await probe(h);
      await probe(h);
      const types = h.control.commands.slice(before).map((entry) => entry.type);
      assert.deepEqual(types, ["reload", command, command]);
    } finally {
      await h.dispose();
    }
  });

  test(`MF5: ${command} cannot use stale config after a reload failure; explicit retry reloads again`, async () => {
    const h = runtimeHarness();
    try {
      await h.configApi.listAvailableModels(LOCAL);
      const before = h.control.commands.length;
      h.executor.setFile(modelsPath, modelsText("fresh"));
      h.failControl("probe reload failed");
      await assert.rejects(probe(h), /probe reload failed/);
      assert.deepEqual(
        h.control.commands.slice(before).map((entry) => entry.type),
        ["reload"],
      );
      h.failControl();
      await probe(h);
      assert.deepEqual(
        h.control.commands.slice(before).map((entry) => entry.type),
        ["reload", "reload", command],
      );
    } finally {
      await h.dispose();
    }
  });
}
