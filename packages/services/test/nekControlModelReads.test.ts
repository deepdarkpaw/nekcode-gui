import assert from "node:assert/strict";
import test from "node:test";
import { NekControlModelReads } from "../src/nek-config-api/controlModelReads.js";
import { createNekModelFactsSource } from "../src/model-provider/nekModelFacts.js";
import { createNekModelSelectionService } from "../src/model-provider/nekModelSelectionService.js";
import { runtimeHarness, modelsPath, modelsText } from "./nekModelRuntimeHarness.js";

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Opening/restoring views fans out Root/composer/readiness reads while a control process is busy. */
test("concurrent model views share control reads instead of exhausting model admission slots", async () => {
  const h = runtimeHarness();
  const service = createNekModelSelectionService({ facts: createNekModelFactsSource(h.configApi) });
  try {
    const views = await Promise.all(
      Array.from({ length: 32 }, (_, i) =>
        service.getView({
          workspacePath: `/project-${i % 4}`,
          selection: i % 2 ? { providerId: "CPA", modelId: "old" } : null,
        }),
      ),
    );
    assert.equal(views.length, 32);
    assert.ok(views.every((view) => view.providers[0]?.models[0]?.modelId === "old"));
    assert.ok(h.control.commands.filter((c) => c.type === "get_available_models").length < 5);
    const before = h.control.commands.filter((c) => c.type === "get_available_models").length;
    await service.getView();
    assert.ok(
      h.control.commands.filter((c) => c.type === "get_available_models").length > before,
      "settled results are never cached",
    );
  } finally {
    service.dispose();
    await h.dispose();
  }
});

test("content changes and explicit invalidation separate in-flight generations even before watch fires", async () => {
  const h = runtimeHarness();
  const reads = new NekControlModelReads(h.executor);
  const waiting = gate<string>();
  const entered = gate<void>();
  try {
    const first = reads.run({ type: "get_available_models" }, async () => {
      entered.resolve();
      return await waiting.promise;
    });
    await entered.promise;
    h.executor.setFile(modelsPath, modelsText("new"));
    assert.equal(await reads.run({ type: "get_available_models" }, async () => "new"), "new");
    waiting.resolve("old");
    assert.equal(await first, "old");
    const secondGate = gate<string>(),
      secondEntered = gate<void>();
    const second = reads.run({ type: "get_available_models" }, async () => {
      secondEntered.resolve();
      return await secondGate.promise;
    });
    await secondEntered.promise;
    reads.invalidate();
    assert.equal(
      await reads.run({ type: "get_available_models" }, async () => "after-auth"),
      "after-auth",
    );
    secondGate.resolve("before-auth");
    assert.equal(await second, "before-auth");
  } finally {
    reads.dispose();
    await h.dispose();
  }
});

test("identical concurrent reads share failures; changed params and targets never share; retry is fresh", async () => {
  const h = runtimeHarness();
  const reads = new NekControlModelReads(h.executor),
    other = new NekControlModelReads(h.executor);
  let calls = 0;
  const waiting = gate<void>();
  try {
    const operation = async () => {
      calls++;
      await waiting.promise;
      throw new Error("catalog read failed");
    };
    const a = reads.run({ type: "get_model_catalog", ids: ["a"] }, operation);
    const b = reads.run({ type: "get_model_catalog", ids: ["a"] }, operation);
    const rejected = Promise.all([
      assert.rejects(a, /catalog read failed/),
      assert.rejects(b, /catalog read failed/),
    ]);
    assert.equal(await reads.run({ type: "get_model_catalog", ids: ["b"] }, async () => "b"), "b");
    assert.equal(
      await other.run({ type: "get_model_catalog", ids: ["a"] }, async () => "remote"),
      "remote",
    );
    waiting.resolve();
    await rejected;
    assert.equal(calls, 1);
    assert.equal(
      await reads.run({ type: "get_model_catalog", ids: ["a"] }, async () => "recovered"),
      "recovered",
    );
  } finally {
    reads.dispose();
    other.dispose();
    await h.dispose();
  }
});

test("unique in-flight work is bounded and dispose rejects late completion", async () => {
  const h = runtimeHarness(),
    reads = new NekControlModelReads(h.executor);
  const waiting = gate<string>();
  let entered = 0;
  try {
    const pending = Array.from({ length: 16 }, (_, i) =>
      reads.run({ type: "get_model_catalog", ids: [String(i)] }, async () => {
        entered++;
        return await waiting.promise;
      }),
    );
    while (entered !== 16) await new Promise((done) => setImmediate(done));
    await assert.rejects(
      reads.run({ type: "get_available_models" }, async () => "not run"),
      /capacity/,
    );
    const rejected = Promise.all(pending.map((promise) => assert.rejects(promise, /disposed/)));
    reads.dispose();
    waiting.resolve("late");
    await rejected;
    await assert.rejects(
      reads.run({ type: "get_available_models" }, async () => "not run"),
      /disposed/,
    );
  } finally {
    reads.dispose();
    await h.dispose();
  }
});
