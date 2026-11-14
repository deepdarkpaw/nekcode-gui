import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { createNekModelFactsSource } from "../src/model-provider/nekModelFacts.js";
import { createNekModelSelectionService } from "../src/model-provider/nekModelSelectionService.js";
import { runtimeHarness, LOCAL, agentDir } from "./nekModelRuntimeHarness.js";
import { waitFor } from "./nekModelFactsFixture.js";

/** Real config/runtime composition, fake CLI and isolated in-memory configuration. */
test("ML2/ML9: auth/settings control freshness never waits for an unrelated hanging session reload", async () => {
  const h = runtimeHarness();
  const service = createNekModelSelectionService({ facts: createNekModelFactsSource(h.configApi) });
  let release!: () => void;
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  try {
    await h.open();
    await service.getView();
    const controlReloads = () => h.control.commands.filter((c) => c.type === "reload").length;
    const before = controlReloads();
    h.onReload(() => blocked);
    const path = join(agentDir, "settings.json");
    h.executor.setFile(path, '{"defaultThinkingLevel":"low"}');
    const settings = await h.configApi.readSettings(LOCAL, "global");
    await h.configApi.patchSettings(
      LOCAL,
      "global",
      { defaultThinkingLevel: "high" },
      { revision: settings.revision },
    );
    const read = service.getView();
    void read.catch(() => undefined);
    await waitFor(() => controlReloads() > before);
    assert.equal((await read).providers[0]?.models[0]?.modelId, "old");
  } finally {
    release();
    service.dispose();
    await h.dispose();
  }
});

test("ML2: a project default write reloads only its live workspace, not shared control or another session", async () => {
  const h = runtimeHarness();
  const service = createNekModelSelectionService({ facts: createNekModelFactsSource(h.configApi) });
  const cwd = resolve(".tmp/model-menu/project-a");
  const other = resolve(".tmp/model-menu/project-b");
  try {
    await h.open(cwd);
    await h.open(other);
    await service.getView({ selection: null, workspacePath: cwd });
    const before = h.control.commands.filter((command) => command.type === "reload").length;
    const settings = await h.configApi.readSettings(LOCAL, "project", cwd);
    await h.configApi.patchSettings(
      LOCAL,
      "project",
      { defaultThinkingLevel: "low" },
      { revision: settings.revision, cwd },
    );
    await waitFor(() => h.sessions[0]!.commands.some((command) => command.type === "reload"));
    await service.getView({ selection: null, workspacePath: cwd });
    assert.equal(h.control.commands.filter((command) => command.type === "reload").length, before);
    assert.equal(h.sessions[1]!.commands.filter((command) => command.type === "reload").length, 0);
  } finally {
    service.dispose();
    await h.dispose();
  }
});

test("ML1/ML9: synthetic local cold/warm benchmark reports observations without wall-clock assertions", async (t) => {
  const h = runtimeHarness();
  const service = createNekModelSelectionService({ facts: createNekModelFactsSource(h.configApi) });
  try {
    const started = performance.now();
    await service.getView();
    const coldMs = performance.now() - started;
    const afterCold = h.control.commands.filter(
      (command) => command.type === "get_available_models",
    ).length;
    const warmStarted = performance.now();
    await service.getView();
    const warmMs = performance.now() - warmStarted;
    t.diagnostic(
      JSON.stringify({ coldMs, warmMs, coldGoalMs: 5000, warmGoalMs: 500, synthetic: true }),
    );
    assert.equal(h.control.commands.filter((command) => command.type === "reload").length, 0);
    assert.equal(
      h.control.commands.filter((command) => command.type === "get_available_models").length,
      afterCold + 1,
    );
  } finally {
    service.dispose();
    await h.dispose();
  }
});
