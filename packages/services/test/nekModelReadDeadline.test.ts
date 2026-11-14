import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import type { NekRpcProcessHandle, NekRpcProcessExit } from "../src/nek-agent/nekRpcClient.js";
import type { NekModelRuntimeHandle, NekRpcCommand } from "@zcode/shared/nek-protocol";
import { DEFAULT_GUI_RUNTIME_CONFIG, parseGuiRuntimeConfig } from "@zcode/shared/guiRuntimeConfig";
import {
  NekConfigApi,
  NekConfigRuntime,
  createMemoryNekConfigHostExecutor,
  nekConfigApiConfigFromRuntime,
  NekModelReadBudget,
  createNekControlClient,
} from "../src/nek-config-api/index.js";
import type { NekControlClient } from "../src/nek-config-api/index.js";
import { NekControlModelReads } from "../src/nek-config-api/controlModelReads.js";
import { NekModelControls } from "../src/nek-config-api/modelControls.js";
import { NekModelRuntimeOwner } from "../src/nek-config-api/modelRuntime.js";
import {
  createNekModelFactsSource,
  NekModelFactsReadError,
} from "../src/model-provider/nekModelFacts.js";
import { createNekModelSelectionService } from "../src/model-provider/nekModelSelectionService.js";
import { createFakeFactsApi, countCalls, waitFor } from "./nekModelFactsFixture.js";
import { createProcess } from "./nekSessionHarness.js";

const LOCAL = { kind: "local" as const };
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 6; i++) await new Promise<void>((done) => setImmediate(done));
}
function client(close = () => undefined): NekControlClient {
  return {
    call: (async (command: NekRpcCommand) => {
      if (command.type === "reload") return { deferred: false, diagnostics: [] };
      if (command.type === "auth_status") return { providers: [] };
      return { models: [] };
    }) as NekControlClient["call"],
    onAuthEvent: () => () => undefined,
    respondExtensionUi: () => undefined,
    setStructuredHandler: () => undefined,
    close: async () => close(),
  };
}

test("ML4/ML5: a completed startup deadline never poisons later control crash recovery", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const handles: NekRpcProcessHandle[] = [];
  const executor = createMemoryNekConfigHostExecutor({
    spawn: async () => {
      const stdin = new PassThrough(),
        stdout = new PassThrough();
      const exits = new Set<(exit: NekRpcProcessExit) => void>();
      const handle: NekRpcProcessHandle = {
        stdin,
        stdout,
        kill: () => {
          for (const notify of Array.from(exits)) notify({ code: 0, signal: null });
        },
        onExit: (notify) => {
          exits.add(notify);
          return () => exits.delete(notify);
        },
      };
      stdin.on("finish", handle.kill);
      stdin.on("data", (line: Buffer) => {
        const command = JSON.parse(line.toString());
        queueMicrotask(() =>
          stdout.write(
            `${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: { models: [] } })}\n`,
          ),
        );
      });
      handles.push(handle);
      return handle;
    },
  });
  const budget = new NekModelReadBudget(100);
  const control = await createNekControlClient({
    target: LOCAL,
    executor,
    context: budget.context,
  });
  try {
    budget.finish();
    t.mock.timers.tick(1000);
    handles[0]!.kill();
    await control.call({ type: "get_available_models" });
    assert.equal(handles.length, 2);
  } finally {
    budget.finish();
    await control.close();
  }
});

test("ML4/ML5/ML9: startup is inside the budget; a late startup is retired, bounded and retryable", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const executor = createMemoryNekConfigHostExecutor();
  const starting = gate<NekControlClient>();
  let starts = 0,
    closes = 0;
  const api = new NekConfigApi({
    hosts: { executor: () => executor, listTargets: async () => [] },
    config: { modelReadMs: 100 },
    control: async () => {
      starts++;
      return starts === 1 ? starting.promise : client();
    },
  });
  const service = createNekModelSelectionService({ facts: createNekModelFactsSource(api) });
  try {
    const read = service.getView();
    const failed = assert.rejects(read, /deadline/);
    await flush();
    assert.equal(starts, 1);
    t.mock.timers.tick(100);
    await failed;
    await assert.rejects(service.getView(), /deadline/);
    assert.equal(starts, 1, "a stuck locator/factory cannot accumulate abandoned startups");
    starting.resolve(
      client(() => {
        closes++;
      }),
    );
    await flush();
    assert.equal(closes, 1);
    assert.deepEqual((await service.getView()).providers, []);
    assert.equal(starts, 2);
  } finally {
    service.dispose();
    api.dispose();
  }
});

test("ML5: startup timeout releases its watch lease immediately, not only when a stuck factory settles", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const executor = createMemoryNekConfigHostExecutor();
  const blocked = gate<NekControlClient>();
  const owner = new NekModelRuntimeOwner();
  let stopped = 0;
  const controls = new NekModelControls({
    config: {
      hosts: { executor: () => executor, listTargets: async () => [] },
      config: { modelReadMs: 100 },
      control: () => blocked.promise,
    },
    target: (target) => ({
      target,
      key: "local",
      executor,
      layout: { agentDir: executor.agentDir() },
    }),
    owner,
    report: () => undefined,
    watch: () => () => {
      stopped++;
    },
  });
  try {
    const pending = controls.get(LOCAL);
    const failure = assert.rejects(pending, /deadline/);
    t.mock.timers.tick(100);
    await failure;
    assert.equal(stopped, 1);
    blocked.resolve(client());
    await flush();
    assert.equal(stopped, 1, "late retirement cannot double-release a watch lease");
  } finally {
    controls.dispose();
    owner.dispose();
  }
});

test("ML3/ML4/ML5/ML9: cancelled queue admission is removed before RPC submission; 32 equal waiters share work", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const executor = createMemoryNekConfigHostExecutor();
  const owner = new NekModelRuntimeOwner();
  const reads = new NekControlModelReads(executor);
  const blocked = gate<void>();
  let submitted = 0;
  const handle: NekModelRuntimeHandle = {
    sessionKey: "control",
    cwd: "",
    isWritable: () => true,
    reload: async () => ({ deferred: false, diagnostics: [] }),
    rebindModel: async () => undefined,
    call: client().call,
  };
  const lease = owner.register(
    { handle, fingerprint: async () => "same", release: () => undefined },
    { initialFingerprint: "same" },
  );
  const active = lease.run("input", () => blocked.promise);
  const budget = new NekModelReadBudget(100);
  try {
    await flush();
    const pending = Array.from({ length: 32 }, () =>
      reads.run(
        { type: "get_available_models" },
        (context) =>
          lease.run(
            "selection",
            async () => {
              submitted++;
              return "ready";
            },
            context,
          ),
        budget.context,
      ),
    );
    const failures = Promise.all(pending.map((p) => assert.rejects(p, /deadline/)));
    await flush();
    t.mock.timers.tick(100);
    await failures;
    blocked.resolve();
    await active;
    await flush();
    assert.equal(
      submitted,
      0,
      "cancelled queued work never executes after the unrelated turn ends",
    );
    assert.equal(
      await reads.run({ type: "get_available_models" }, (context) =>
        lease.run("selection", async () => "retry", context),
      ),
      "retry",
    );
  } finally {
    budget.finish();
    reads.dispose();
    owner.dispose();
  }
});

test("ML4/ML5: a short-budget getView waiter detaches without extending its deadline or cancelling another caller", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const api = createFakeFactsApi();
  const blocked = api.gateNextRead();
  const service = createNekModelSelectionService({
    facts: createNekModelFactsSource({ ...api, modelReadMs: 100 }),
  });
  try {
    const original = service.getView();
    await flush();
    const joining = service.getView(undefined, { elapsedMs: 90 });
    const failed = assert.rejects(joining, /deadline/);
    t.mock.timers.tick(10);
    await failed;
    assert.equal(countCalls(api, "listAvailableModels"), 1);
    blocked.resolve();
    await original;
    await service.getView();
    assert.equal(countCalls(api, "listAvailableModels"), 2, "a settled result is never cached");
  } finally {
    service.dispose();
  }
});

test("ML4/ML5: a timed-out facts RPC detaches every pending waiter and retry reuses the live control", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const blocked = gate<unknown>();
  let slow = true;
  const h = createProcess((command) => {
    if (command.type === "auth_status") return { providers: [] };
    if (slow) return blocked.promise;
    return { models: [] };
  });
  let starts = 0;
  const executor = createMemoryNekConfigHostExecutor();
  const api = new NekConfigApi({
    hosts: { executor: () => executor, listTargets: async () => [] },
    config: { modelReadMs: 100 },
    control: async () => {
      starts++;
      return { ...client(), call: (command, context) => h.process.client.call(command, context) };
    },
  });
  const service = createNekModelSelectionService({ facts: createNekModelFactsSource(api) });
  try {
    const pending = service.getView();
    const failed = assert.rejects(pending, /deadline/);
    await flush();
    assert.ok(h.process.client.pendingCount > 0);
    t.mock.timers.tick(100);
    await failed;
    await flush();
    assert.equal(h.process.client.pendingCount, 0);
    slow = false;
    blocked.resolve({ models: [] });
    await flush();
    await service.getView();
    assert.equal(starts, 1);
    assert.equal(h.process.client.state, "open");
  } finally {
    service.dispose();
    api.dispose();
    await h.process.dispose();
  }
});

test("ML2: global auth invalidation refreshes control even when models.json content is unchanged", async () => {
  const executor = createMemoryNekConfigHostExecutor();
  let reloads = 0;
  const fake = client();
  const call = fake.call;
  fake.call = (async (command: NekRpcCommand) => {
    if (command.type === "reload") reloads++;
    return call(command);
  }) as NekControlClient["call"];
  const runtime = new NekConfigRuntime({
    hosts: { executor: () => executor, listTargets: async () => [] },
    config: { autoReload: false },
    control: async () => fake,
  });
  try {
    await (await runtime.control(LOCAL)).call({ type: "get_available_models" });
    assert.equal(reloads, 0);
    runtime.publishWrite(LOCAL, [
      { path: `${executor.agentDir()}/auth.json`, revision: "auth-changed" },
    ]);
    await runtime.refreshModelControl(LOCAL);
    assert.equal(reloads, 1);
    await runtime.refreshModelControl(LOCAL);
    assert.equal(reloads, 1);
  } finally {
    runtime.dispose();
  }
});

test("ML5: one cancelled shared waiter does not cancel another still-leased reader", async () => {
  const reads = new NekControlModelReads(createMemoryNekConfigHostExecutor());
  const blocked = gate<string>();
  const controller = new AbortController();
  let entered = 0;
  const run = async () => {
    entered++;
    return blocked.promise;
  };
  try {
    const a = reads.run({ type: "get_model_catalog" }, run, { signal: controller.signal });
    const b = reads.run({ type: "get_model_catalog" }, run);
    await flush();
    const cancelled = assert.rejects(a, /cancelled/);
    controller.abort(new Error("cancelled reader"));
    await cancelled;
    blocked.resolve("current");
    assert.equal(await b, "current");
    assert.equal(entered, 1);
  } finally {
    reads.dispose();
  }
});

test("ML4/ML7: dirty reread uses the original deadline and disposal releases observation immediately", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const api = createFakeFactsApi();
  const facts = createNekModelFactsSource({ ...api, modelReadMs: 100 });
  const service = createNekModelSelectionService({ facts });
  const first = api.gateNextRead(),
    second = api.gateNextRead();
  try {
    const read = service.getView({ selection: null, workspacePath: "/project" });
    const failure = assert.rejects(read, /deadline/);
    await flush();
    t.mock.timers.tick(80);
    for (let i = 0; i < 100; i++) api.notifyWatch();
    first.resolve();
    await flush();
    assert.equal(countCalls(api, "listAvailableModels"), 2);
    t.mock.timers.tick(20);
    await failure;
    second.resolve();
    await flush();
    await service.getView();
    assert.equal(api.watchDisposed, 1, "temporary project lease is detached at timeout");
  } finally {
    service.dispose();
  }
});

test("ML5: target replacement rejects a late old control read and never borrows local facts", async () => {
  const first = createMemoryNekConfigHostExecutor({ id: "remote:one" });
  const replacement = createMemoryNekConfigHostExecutor({ id: "remote:two" });
  let executor = first;
  const blocked = gate<unknown>();
  let calls = 0;
  const old = client();
  old.call = (async (command: NekRpcCommand) => {
    if (command.type === "get_available_models") {
      calls++;
      return blocked.promise;
    }
    return { models: [] };
  }) as NekControlClient["call"];
  let creates = 0;
  const runtime = new NekConfigRuntime({
    hosts: {
      executor: (target) => (target.kind === "remote" ? executor : undefined),
      listTargets: async () => [],
    },
    control: async () => (++creates === 1 ? old : client()),
  });
  const target = { kind: "remote" as const, connectionId: "remote" };
  try {
    const control = await runtime.control(target);
    const reading = control.call({ type: "get_available_models" });
    const rejected = assert.rejects(reading, /changed|disposed/);
    await waitFor(() => calls === 1);
    executor = replacement;
    await runtime.control(target);
    await rejected;
    blocked.resolve({ models: [] });
    await assert.rejects(runtime.control(LOCAL), /connected/);
  } finally {
    runtime.dispose();
  }
});

test("ML5/ML6: RPC cancellation clears pending state and ignores late replies without killing the process", async () => {
  const blocked = gate<unknown>();
  const h = createProcess(() => blocked.promise);
  const controller = new AbortController();
  try {
    const read = h.process.client.call(
      { type: "get_available_models" },
      { signal: controller.signal },
    );
    const cancelled = assert.rejects(read, /cancelled/);
    await flush();
    assert.equal(h.process.client.pendingCount, 1);
    controller.abort(new Error("cancelled model menu"));
    await cancelled;
    assert.equal(h.process.client.pendingCount, 0);
    assert.equal(h.process.client.state, "open");
    blocked.resolve({ models: [] });
    await flush();
    assert.equal(h.process.client.pendingCount, 0);
    assert.equal(h.process.client.state, "open");
  } finally {
    await h.process.dispose();
  }
});

test("ML6: available/catalog/auth/settings failures retain distinct stages and original causes; timing logs contain no payloads", async () => {
  const failure = new Error("synthetic failure");
  for (const [method, stage] of [
    ["listAvailableModels", "get_available_models"],
    ["getModelCatalog", "get_model_catalog"],
    ["getAuthStatus", "auth_status"],
    ["readSettings", "settings"],
  ] as const) {
    const api = createFakeFactsApi();
    const logs: unknown[] = [];
    const facts = createNekModelFactsSource(
      {
        ...api,
        [method]: async () => {
          throw failure;
        },
      },
      { log: { warn: () => undefined, debug: (...args) => logs.push(args) } },
    );
    try {
      await assert.rejects(
        facts.read(),
        (error: unknown) =>
          error instanceof NekModelFactsReadError &&
          error.stage === stage &&
          error.cause === failure,
      );
      const text = JSON.stringify(logs);
      for (const key of ["start", "control-ready", "queue", "reload", "facts", "finish"])
        assert.ok(text.includes(key));
      assert.ok(!text.includes("synthetic failure"));
    } finally {
      facts.dispose();
    }
  }
});

test("ML4: GUI runtime modelReadMs validates and maps into an injected config API budget", () => {
  assert.equal(DEFAULT_GUI_RUNTIME_CONFIG.timeouts.modelReadMs, 15000);
  const loaded = parseGuiRuntimeConfig({ timeouts: { modelReadMs: 77 } });
  assert.equal(loaded.diagnostics.length, 0);
  const api = new NekConfigApi({
    hosts: { executor: () => undefined, listTargets: async () => [] },
    config: nekConfigApiConfigFromRuntime(loaded.config),
  });
  try {
    assert.equal(createNekModelFactsSource(api).modelReadMs, 77);
  } finally {
    api.dispose();
  }
  assert.ok(
    parseGuiRuntimeConfig({ timeouts: { modelReadMs: 0 } }).diagnostics.some(
      (d) => d.path === "timeouts.modelReadMs",
    ),
  );
});
