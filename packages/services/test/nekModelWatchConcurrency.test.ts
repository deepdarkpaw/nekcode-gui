import assert from "node:assert/strict";
import test from "node:test";
import { createNekModelFactsSource } from "../src/model-provider/nekModelFacts.js";
import { createNekModelSelectionService } from "../src/model-provider/nekModelSelectionService.js";
import { catalogModel, countCalls, createFakeFactsApi, waitFor } from "./nekModelFactsFixture.js";

const A = catalogModel({ provider: "mock", id: "a" });
const B = catalogModel({ provider: "mock", id: "b" });
function setup() {
  const api = createFakeFactsApi({ available: [A], catalog: [A] });
  const service = createNekModelSelectionService({ facts: createNekModelFactsSource(api) });
  return { api, service };
}

test("MW-C1: one inflight invalidated without a second reader cannot commit stale facts", async () => {
  const { api, service } = setup();
  const gate = api.gateNextRead();
  const pending = service.getView();
  await waitFor(() => countCalls(api, "listAvailableModels") === 1);
  api.setCatalog([B], [B]);
  api.notifyWatch();
  gate.resolve();
  const view = await pending;
  assert.equal(view.providers[0]?.models[0]?.modelId, "b");
  assert.equal(view.revision, 1, "stale facts never committed a revision");
  assert.equal(countCalls(api, "reloadRunningSessions"), 1);
  service.dispose();
});

test("MW-C2: a newer failed read fences an older successful snapshot", async () => {
  const { api, service } = setup();
  const gate = api.gateNextRead();
  const older = service.getView();
  api.setReadError(new Error("newer read failed"));
  await assert.rejects(service.getView(), /newer read failed/);
  api.setReadError(undefined);
  api.setCatalog([B], [B]);
  gate.resolve();
  assert.equal((await older).providers[0]?.models[0]?.modelId, "b");
  assert.equal(countCalls(api, "listAvailableModels"), 3);
  service.dispose();
});

test("MW-C3: retry exhaustion is visible, not a last stale view", async () => {
  const { api, service } = setup();
  const gates = [api.gateNextRead(), api.gateNextRead(), api.gateNextRead()];
  const pending = service.getView();
  const rejected = assert.rejects(pending, /changed during every read/);
  for (const [index, gate] of gates.entries()) {
    await waitFor(() => countCalls(api, "listAvailableModels") === index + 1);
    api.notifyWatch();
    gate.resolve();
  }
  await rejected;
  const recovered = await service.getView();
  assert.equal(recovered.revision, 1, "no stale attempt was committed");
  service.dispose();
});

test("MW-C4: concurrent readers share reload; invalidation during reload repeats it before IO", async () => {
  const { api, service } = setup();
  await service.getView();
  api.notifyWatch();
  const firstGate = api.gateNextReload();
  const secondGate = api.gateNextReload();
  const first = service.getView();
  const second = service.getView();
  assert.equal(countCalls(api, "reloadRunningSessions"), 1);
  api.notifyWatch();
  firstGate.resolve();
  await waitFor(() => countCalls(api, "reloadRunningSessions") === 2);
  assert.equal(countCalls(api, "listAvailableModels"), 1, "no facts IO between outdated reloads");
  secondGate.resolve();
  await Promise.all([first, second]);
  assert.equal(countCalls(api, "reloadRunningSessions"), 2);
  service.dispose();
});

test("MW-W1: global + two workspace leases are scoped, reference counted and released", async () => {
  const { api, service } = setup();
  const notifications: string[] = [];
  const a = service.onDynamicDidChange({ workspacePath: "/a" })(() => notifications.push("a"));
  const a2 = service.onDynamicDidChange({ workspacePath: "/a" })(() => notifications.push("a2"));
  const b = service.onDynamicDidChange({ workspacePath: "/b" })(() => notifications.push("b"));
  const global = service.onDidChange(() => notifications.push("global"));
  assert.equal(countCalls(api, "watch"), 3, "global + one per workspace, not per consumer");
  for (let index = 0; index < 10; index += 1) await service.getView({ selection: null, workspacePath: "/a" });
  assert.equal(countCalls(api, "watch"), 3);
  api.notifyWatch("/a");
  assert.deepEqual(notifications, ["a", "a2"]);
  assert.equal(countCalls(api, "reloadRunningSessions"), 0, "project defaults do not reload other sessions");
  a.dispose();
  assert.equal(api.watchDisposed, 0);
  a2.dispose();
  assert.equal(api.watchDisposed, 1);
  notifications.length = 0;
  api.notifyWatch("/a");
  api.notifyWatch("/b");
  assert.deepEqual(notifications, ["b"]);
  notifications.length = 0;
  api.notifyWatch();
  assert.deepEqual(notifications.sort(), ["b", "global"]);
  b.dispose();
  global.dispose();
  service.dispose();
  assert.equal(api.watchDisposed, 3);
});

test("MW-W2: one-shot workspace reads never retain historical directory leases", async () => {
  const { api, service } = setup();
  for (let index = 0; index < 140; index += 1) {
    await service.getView({ selection: null, workspacePath: `/project-${index}` });
  }
  assert.equal(api.watchDisposed, 140);
  assert.equal(countCalls(api, "watch"), 141);
  service.dispose();
});

test("MW-E1: async watch failures invalidate ready and remain errors until recovery", async () => {
  const { api, service } = setup();
  const lease = service.onDynamicDidChange({ workspacePath: "/a" })(() => undefined);
  await service.getView({ selection: null, workspacePath: "/a" });
  api.notifyWatch("/a", "project EACCES");
  await assert.rejects(service.getView({ selection: null, workspacePath: "/a" }), /project EACCES/);
  await service.getView({ selection: null, workspacePath: "/b" });
  api.notifyWatch("/a");
  await service.getView({ selection: null, workspacePath: "/a" });
  api.notifyWatch(undefined, "global EACCES");
  await assert.rejects(service.getView({ selection: null, workspacePath: "/b" }), /global EACCES/);
  api.notifyWatch();
  await service.getView();
  lease.dispose();
  service.dispose();
});

test("MW-D1: partial or empty explicit defaults never choose the first model", async () => {
  const { api, service } = setup();
  for (const defaults of [{ defaultProvider: "mock" }, { defaultModel: "a" }, { defaultProvider: "", defaultModel: "" }]) {
    api.setEffective(defaults);
    const view = await service.getView();
    assert.equal(view.preferredSelection, undefined);
    assert.equal(view.preferredSelectionIssue, "configured-default-unavailable");
  }
  service.dispose();
});

test("MW-C5: disposal rejects inflight reads and releases temporary project leases", async () => {
  const { api, service } = setup();
  const gate = api.gateNextRead();
  const pending = service.getView({ selection: null, workspacePath: "/a" });
  service.dispose();
  gate.resolve();
  await assert.rejects(pending, /dispose/);
  assert.equal(api.watchDisposed, 2);
});
