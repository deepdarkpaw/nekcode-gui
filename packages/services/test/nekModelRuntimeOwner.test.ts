import assert from "node:assert/strict";
import test from "node:test";
import {
  NekModelRuntimeOwner,
  modelRuntimeFingerprint,
} from "../src/nek-config-api/modelRuntime.js";
import { NekLiveModelRuntimes } from "../src/nek-config-api/liveModelRuntimes.js";
import {
  createMemoryNekConfigHostExecutor,
  type NekReloadOutcome,
} from "../src/nek-config-api/index.js";
import type { NekModelRuntimeHandle } from "@zcode/shared/nek-protocol";
import type { NekWatchChange } from "../src/nek-config-api/watch.js";
import { LOCAL, modelsPath, modelsText, agentDir } from "./nekModelRuntimeHarness.js";

function writer(reload: NekModelRuntimeHandle["reload"]): NekModelRuntimeHandle {
  return {
    sessionKey: "live",
    cwd: "/work",
    isWritable: () => true,
    reload,
    rebindModel: async () => undefined,
    call: async () => {
      throw new Error("unexpected RPC");
    },
  };
}

test("MR10: content churn has a bounded retry budget and never submits stale input", async () => {
  const owner = new NekModelRuntimeOwner();
  let generation = 0;
  let submitted = false;
  const lease = owner.register({
    handle: writer(async () => {
      generation++;
      return { deferred: false, diagnostics: [] };
    }),
    fingerprint: async () => String(generation),
    release: () => undefined,
  });
  try {
    await assert.rejects(
      lease.run("input", async () => {
        submitted = true;
      }),
      /kept changing.*retry/,
    );
    assert.equal(generation, 3);
    assert.equal(submitted, false);
  } finally {
    owner.dispose();
  }
});

test("MR11: admission/registration capacity is bounded; concurrent explicit reloads dedupe", async () => {
  const owner = new NekModelRuntimeOwner();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reloads = 0;
  const handle = writer(async () => {
    reloads++;
    await barrier;
    return { deferred: false, diagnostics: [] };
  });
  const lease = owner.register({
    handle,
    fingerprint: async () => "one",
    release: () => undefined,
  });
  try {
    const one = lease.reload();
    const two = lease.reload();
    const pending = Array.from({ length: 15 }, () => lease.run("selection", async () => true));
    await assert.rejects(
      lease.run("selection", async () => true),
      /capacity.*retry/,
    );
    release();
    await Promise.all([one, two, ...pending]);
    assert.equal(reloads, 1);
    for (let i = 0; i < 127; i++)
      owner.register({ handle, fingerprint: async () => "one", release: () => undefined });
    assert.throws(
      () => owner.register({ handle, fingerprint: async () => "one", release: () => undefined }),
      /capacity/,
    );
  } finally {
    release();
    owner.dispose();
  }
});

test("MR12: one target watch serves all scopes, reports external reload failures, and releases on last detach", async () => {
  const executor = createMemoryNekConfigHostExecutor({
    agentDir,
    files: { [modelsPath]: modelsText() },
  });
  let notify: (change: NekWatchChange) => void = () => undefined;
  let watches = 0;
  let stops = 0;
  const reports: NekReloadOutcome[] = [];
  const registry = new NekLiveModelRuntimes({
    watch: (_target, listener) => {
      watches++;
      notify = listener;
      return () => {
        stops++;
      };
    },
    report: (_target, result) => reports.push(result),
    warn: () => undefined,
  });
  let reloads = 0;
  let failure = false;
  const handle = writer(async () => {
    reloads++;
    if (failure) throw new Error("watch reload failed");
    return { deferred: false, diagnostics: [] };
  });
  const port = registry.forTarget({ target: LOCAL, key: "local", executor, layout: { agentDir } });
  const a = port.register(handle);
  const b = port.register({ ...handle, cwd: "/other" });
  try {
    assert.equal(watches, 1);
    await Promise.all([a.run("selection", async () => true), b.run("selection", async () => true)]);
    failure = true;
    executor.setFile(modelsPath, modelsText("new"));
    notify({ file: modelsPath, scope: "global", revision: "changed" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(
      reports.some((result) =>
        result.failures.some((item) => item.message === "watch reload failed"),
      ),
    );
    failure = false;
    await a.run("selection", async () => true);
    assert.equal(reloads, 5);
    a.dispose();
    assert.equal(stops, 0);
    b.dispose();
    assert.equal(stops, 1);
    assert.equal(registry.sessions("local").length, 0);
  } finally {
    registry.dispose();
  }
});

test("MR14: a successful but late reload ACK cannot authorize a replaced process", async () => {
  const owner = new NekModelRuntimeOwner();
  let live = true;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let submitted = false;
  const handle = {
    ...writer(async () => {
      entered();
      await barrier;
      return { deferred: false, diagnostics: [] };
    }),
    isWritable: () => live,
  };
  const lease = owner.register({
    handle,
    fingerprint: async () => "one",
    release: () => undefined,
  });
  const rejected = assert.rejects(
    lease.run("selection", async () => {
      submitted = true;
    }),
    /changed or closed.*retry/,
  );
  await waiting;
  live = false;
  release();
  await rejected;
  assert.equal(submitted, false);
  owner.dispose();
});

test("MR13: content hash detects same-size/same-mtime edits; oversized configuration is visibly rejected", async () => {
  const executor = createMemoryNekConfigHostExecutor({
    agentDir,
    files: { [modelsPath]: modelsText("aaa") },
  });
  executor.stat = async () => ({ size: 100, mtimeMs: 1, isDirectory: false });
  const before = await modelRuntimeFingerprint(executor);
  executor.setFile(modelsPath, modelsText("bbb"));
  assert.notEqual(await modelRuntimeFingerprint(executor), before);
  executor.stat = async () => ({ size: 5 * 1024 * 1024, mtimeMs: 1, isDirectory: false });
  await assert.rejects(modelRuntimeFingerprint(executor), /exceeds 4 MB/);
});
