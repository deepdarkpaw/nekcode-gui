import assert from "node:assert/strict";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createNekModelFactsSource } from "../src/model-provider/nekModelFacts.js";
import { createNekModelSelectionService } from "../src/model-provider/nekModelSelectionService.js";
import { catalogModel, createFakeFactsApi } from "./nekModelFactsFixture.js";
import { createHarness, REMOTE, REMOTE_AGENT_DIR } from "./nekConfigApiHarness.js";

const MODEL = catalogModel({ provider: "mock", id: "a", thinkingLevels: ["low", "high"] });
const GLOBAL = join(REMOTE_AGENT_DIR, "settings.json");
const A = join("/project-a", ".nek", "settings.json");
const B = join("/project-b", ".nek", "settings.json");
const settings = (model: string, level: string) =>
  JSON.stringify({ defaultProvider: "mock", defaultModel: model, defaultThinkingLevel: level });

test("MW-I1: real config watch/settings owner updates only the changed workspace and releases A without losing B", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const harness = createHarness({
    remoteFiles: {
      [GLOBAL]: settings("a", "low"),
      [A]: settings("a", "low"),
      [B]: settings("gone", "high"),
    },
    pollSeconds: 1,
  });
  const facts = createFakeFactsApi({ available: [MODEL], catalog: [MODEL] });
  const source = createNekModelFactsSource(
    { ...facts, watch: harness.api.watch, readSettings: harness.api.readSettings },
    { target: REMOTE },
  );
  const service = createNekModelSelectionService({ facts: source });
  t.after(() => {
    service.dispose();
    harness.api.dispose();
  });
  const events: string[] = [];
  const stopA = service.onDynamicDidChange({ workspacePath: "/project-a" })(() => events.push("a"));
  const stopB = service.onDynamicDidChange({ workspacePath: "/project-b" })(() => events.push("b"));
  await setImmediate();
  const beforeA = await service.getView({ selection: null, workspacePath: "/project-a" });
  const beforeB = await service.getView({ selection: null, workspacePath: "/project-b" });
  assert.equal(beforeA.preferredSelection?.options?.reasoningLevel, "low");
  assert.equal(beforeB.preferredSelectionIssue, "configured-default-unavailable");
  events.length = 0;
  const reloads = facts.calls.filter((call) => call.method === "reloadRunningSessions").length;
  harness.remote.setFile(`${B}.tmp`, settings("a", "high"));
  await harness.remote.rename(`${B}.tmp`, B);
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.deepEqual(events, ["b"]);
  const fixedB = await service.getView({ selection: null, workspacePath: "/project-b" });
  assert.equal(fixedB.preferredSelection?.options?.reasoningLevel, "high");
  assert.equal(fixedB.preferredSelectionIssue, undefined);
  assert.equal(
    fixedB.revision,
    beforeA.revision,
    "defaults-only change does not mutate catalog revision",
  );
  assert.equal(
    facts.calls.filter((call) => call.method === "reloadRunningSessions").length,
    reloads,
  );
  stopA.dispose();
  events.length = 0;
  harness.remote.setFile(A, settings("gone", "high"));
  harness.remote.setFile(B, settings("a", "low"));
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.deepEqual(events, ["b"]);
  assert.equal(
    (await service.getView({ selection: null, workspacePath: "/project-b" })).preferredSelection
      ?.options?.reasoningLevel,
    "low",
  );
  events.length = 0;
  harness.remote.setFile(GLOBAL, settings("a", "high"));
  t.mock.timers.tick(1000);
  await setImmediate();
  assert.deepEqual(events, ["b"]);
  stopB.dispose();
});

test("MW-E2: inherited settings diagnostics cannot silently become first-model defaults", async (t) => {
  const harness = createHarness({ remoteFiles: { [GLOBAL]: "{ broken", [A]: "{}" } });
  const facts = createFakeFactsApi({ available: [MODEL], catalog: [MODEL] });
  const service = createNekModelSelectionService({
    facts: createNekModelFactsSource(
      { ...facts, watch: harness.api.watch, readSettings: harness.api.readSettings },
      { target: REMOTE },
    ),
  });
  t.after(() => {
    service.dispose();
    harness.api.dispose();
  });
  await assert.rejects(
    service.getView({ selection: null, workspacePath: "/project-a" }),
    /settings.json/,
  );
  harness.remote.setFile(GLOBAL, settings("a", "high"));
  assert.equal(
    (await service.getView({ selection: null, workspacePath: "/project-a" })).preferredSelection
      ?.modelId,
    "a",
  );
});

test("MW-E3: a disconnected target rejects watch admission instead of returning a dead lease", () => {
  const harness = createHarness();
  harness.disconnect();
  assert.throws(() => harness.api.watch(REMOTE, () => undefined), /not connected/i);
  harness.api.dispose();
});
