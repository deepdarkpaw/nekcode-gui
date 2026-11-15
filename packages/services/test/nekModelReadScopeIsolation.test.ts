import assert from "node:assert/strict";
import test from "node:test";
import {
  createNekModelFactsSource,
  type NekModelFacts,
} from "../src/model-provider/nekModelFacts.js";
import { catalogModel, countCalls, createFakeFactsApi } from "./nekModelFactsFixture.js";
import type { INekConfigApi } from "@zcode/shared/nek-protocol";
import { createNekModelSelectionService } from "../src/model-provider/nekModelSelectionService.js";
import { waitFor } from "./nekModelFactsFixture.js";

function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve(),
  };
}

test("model reads in other workspaces must not exhaust a stable workspace read", async () => {
  const facts: NekModelFacts = { providers: [], models: [], defaults: {} };
  const gates = [deferred(), deferred()];
  let readingCount = 0;
  let settled = false;
  const service = createNekModelSelectionService({
    facts: {
      onDidChange: () => () => {},
      dispose: () => {},
      read: async (options) => {
        if (options?.cwd === "/reading") await gates[Math.min(readingCount++, 1)]!.promise;
        return facts;
      },
    },
  });
  try {
    const reading = service.getView({ selection: null, workspacePath: "/reading" }).finally(() => {
      settled = true;
    });
    // Consume errors only to keep the test process clean until the explicit assertion below.
    void reading.catch(() => {});
    await service.getView({ selection: null, workspacePath: "/other-1" });
    gates[0]!.resolve();
    await waitFor(() => readingCount > 1 || settled);
    await service.getView({ selection: null, workspacePath: "/other-2" });
    gates[1]!.resolve();
    await reading;
    assert.equal(
      readingCount,
      1,
      "no configuration event occurred; unrelated reads are not invalidations",
    );
  } finally {
    gates.forEach((gate) => gate.resolve());
    service.dispose();
  }
});

test("model reads wait for staggered directory baselines instead of consuming both retries on watch-ready", async () => {
  const model = catalogModel({ provider: "mock", id: "stable" });
  const api = createFakeFactsApi({ available: [model], catalog: [model] });
  const ready = deferred();
  let notify!: Parameters<INekConfigApi["watch"]>[1];
  api.watch = (_target, listener, cwd) => {
    if (cwd) notify = listener;
    return Object.assign(() => {}, { ready: ready.promise });
  };
  const service = createNekModelSelectionService({ facts: createNekModelFactsSource(api) });
  try {
    const reading = service.getView({ selection: null, workspacePath: "/project" });
    assert.equal(countCalls(api, "listAvailableModels"), 0);
    for (const directory of ["/project/.nek", "/project/.nek/agents", "/project"]) {
      notify({ file: directory, revision: "watch-ready", scope: "project" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(countCalls(api, "listAvailableModels"), 0);
    }
    ready.resolve();
    const view = await reading;
    assert.equal(view.providers[0]?.models[0]?.modelId, "stable");
    assert.equal(countCalls(api, "listAvailableModels"), 1);
  } finally {
    ready.resolve();
    service.dispose();
  }
});
