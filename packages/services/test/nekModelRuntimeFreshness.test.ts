import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL, modelsPath, modelsText, runtimeHarness } from "./nekModelRuntimeHarness.js";
import { createNekModelFactsSource } from "../src/model-provider/nekModelFacts.js";

const selection = (sessionKey: string, modelId = "old") => ({
  sessionKey,
  provider: "CPA",
  modelId,
});

/** Main writes and each host's admission communicate through the target's actual config bytes. */
test("MR1: production composition wires writers without an injected registry; new model -> reload -> set_model -> prompt", async () => {
  const h = runtimeHarness();
  try {
    const opened = await h.open();
    await h.agentService.service.setModel(selection(opened.sessionKey));
    const before = h.sessions[0]!.commands.length;
    const config = await h.configApi.readModelsConfig(LOCAL);
    await h.configApi.addModels(LOCAL, "CPA", [{ id: "gemini-4-carbon", name: "Gemini" }], {
      revision: config.revision,
    });
    await h.agentService.sendNekConversationCommandV4({
      target: { workspacePath: "/project" },
      envelope: {
        commandId: "new-model",
        clientId: "test",
        sessionId: opened.sessionId,
        type: "sendText",
        issuedAt: 1,
        payload: {
          text: "hello",
          modelSelection: { providerId: "CPA", modelId: "gemini-4-carbon" },
        },
      },
    });
    const commands = h.sessions[0]!.commands.slice(before).map((c) => c.type);
    assert.equal(commands.filter((c) => c === "reload").length, 1);
    assert.ok(commands.indexOf("reload") < commands.indexOf("set_model"));
    assert.ok(commands.indexOf("set_model") < commands.indexOf("prompt"));
    assert.equal(h.sessions[0]!.selected()?.id, "gemini-4-carbon");
  } finally {
    await h.dispose();
  }
});

test("MR2: external same-ID api/baseUrl changes are content-fenced before watcher debounce; unchanged input never reloads", async () => {
  const h = runtimeHarness();
  try {
    const opened = await h.open();
    const { service } = h.agentService;
    await service.setModel(selection(opened.sessionKey));
    const before = h.sessions[0]!.commands.filter((c) => c.type === "reload").length;
    h.executor.setFile(modelsPath, modelsText("old", "http://new", "openai-responses"));
    // No selection in this input: refresh must rebind the currently accepted model object too.
    await service.sendPrompt({
      sessionKey: opened.sessionKey,
      message: "one",
      streamingBehavior: "steer",
    });
    assert.equal(h.sessions[0]!.selected()?.baseUrl, "http://new");
    assert.equal(h.sessions[0]!.selected()?.api, "openai-responses");
    for (let i = 0; i < 4; i++)
      await service.sendPrompt({
        sessionKey: opened.sessionKey,
        message: "unchanged",
        streamingBehavior: "steer",
      });
    assert.equal(h.sessions[0]!.commands.filter((c) => c.type === "reload").length, before + 1);
    // Rewriting identical content/mtime is not a new model generation.
    h.executor.setFile(modelsPath, modelsText("old", "http://new", "openai-responses"));
    await service.setModel(selection(opened.sessionKey));
    assert.equal(h.sessions[0]!.commands.filter((c) => c.type === "reload").length, before + 1);
  } finally {
    await h.dispose();
  }
});

test("MR3: no sessions means no spawning; missing/empty models do not trigger per-input reloads", async () => {
  const h = runtimeHarness();
  try {
    assert.deepEqual(await h.configApi.reloadRunningSessions(LOCAL), {
      reloaded: 0,
      deferred: 0,
      diagnostics: [],
      failures: [],
    });
    assert.equal(h.sessions.length, 0);
    assert.equal(h.control.commands.length, 0);
    h.executor.files.delete(modelsPath);
    const opened = await h.open();
    for (let i = 0; i < 3; i++)
      await h.agentService.service.sendPrompt({
        sessionKey: opened.sessionKey,
        message: "empty",
        streamingBehavior: "steer",
      });
    assert.equal(h.sessions[0]!.commands.filter((c) => c.type === "reload").length, 1);
  } finally {
    await h.dispose();
  }
});

test("MR4: every active scope/window sees machine-local edits; another remote machine remains independent", async () => {
  const a = runtimeHarness();
  const b = runtimeHarness(a.executor);
  const remote = runtimeHarness();
  try {
    const opened = await Promise.all([
      a.open("/a"),
      a.open("/b"),
      b.open("/window"),
      remote.open("/remote"),
    ]);
    a.executor.setFile(modelsPath, modelsText("new", "http://machine-a"));
    await Promise.all(
      opened.map((session, index) =>
        [a, a, b, remote][index]!.agentService.service.setModel(
          selection(session.sessionKey, index === 3 ? "old" : "new"),
        ),
      ),
    );
    assert.deepEqual(
      a.sessions.map((s) => s.selected()?.id),
      ["new", "new"],
    );
    assert.equal(b.sessions[0]!.selected()?.id, "new");
    assert.equal(remote.sessions[0]!.selected()?.id, "old");
    const outcome = await a.configApi.reloadRunningSessions(LOCAL);
    assert.equal(outcome.reloaded, 2);
  } finally {
    await a.dispose();
    await b.dispose();
    await remote.dispose();
  }
});

for (const mode of ["failure", "diagnostics", "deferred"] as const) {
  test(`MR5: ${mode} does not certify freshness or send stale selection; same content retries successfully`, async () => {
    const h = runtimeHarness();
    try {
      const opened = await h.open();
      await h.agentService.service.setModel(selection(opened.sessionKey));
      h.executor.setFile(modelsPath, modelsText("new"));
      if (mode === "failure") h.failReload("reload exploded");
      if (mode === "diagnostics")
        h.setDiagnostics([{ file: modelsPath, severity: "error", message: "bad model endpoint" }]);
      if (mode === "deferred") h.sessions[0]!.busy = true;
      const before = h.sessions[0]!.commands.length;
      await assert.rejects(
        h.agentService.service.setModel(selection(opened.sessionKey, "new")),
        mode === "failure"
          ? /reload exploded/
          : mode === "deferred"
            ? /pending.*retry/
            : /bad model endpoint/,
      );
      await assert.rejects(
        h.agentService.service.sendPrompt({
          sessionKey: opened.sessionKey,
          message: "must not submit",
          streamingBehavior: "steer",
        }),
      );
      assert.equal(
        h.sessions[0]!.commands.slice(before).some((c) =>
          ["set_model", "prompt", "steer", "follow_up"].includes(c.type),
        ),
        false,
      );
      h.failReload();
      h.setDiagnostics([]);
      h.sessions[0]!.busy = false;
      await h.agentService.service.setModel(selection(opened.sessionKey, "new"));
      assert.equal(h.sessions[0]!.selected()?.id, "new");
    } finally {
      await h.dispose();
    }
  });
}

test("MR15: command-time warnings are published; filesystem admission errors reject and remain retryable", async () => {
  const h = runtimeHarness();
  try {
    const opened = await h.open();
    await h.agentService.service.setModel(selection(opened.sessionKey));
    h.executor.setFile(modelsPath, modelsText("warning"));
    const diagnostics: string[] = [];
    const stop = h.configApi.onReloadResult(LOCAL, (result) =>
      diagnostics.push(...result.diagnostics.map((item) => item.message)),
    );
    h.setDiagnostics([{ file: modelsPath, severity: "warning", message: "inspect this model" }]);
    await h.agentService.service.setModel(selection(opened.sessionKey, "warning"));
    assert.ok(diagnostics.includes("inspect this model"));
    stop();
    h.setDiagnostics([]);
    const read = h.executor.readFile;
    h.executor.setFile(modelsPath, modelsText("after-io"));
    h.executor.readFile = async (path) => {
      if (path === modelsPath) throw new Error("models read denied");
      return await read(path);
    };
    await assert.rejects(
      h.agentService.service.setModel(selection(opened.sessionKey, "after-io")),
      /models read denied/,
    );
    h.executor.readFile = read;
    await h.agentService.service.setModel(selection(opened.sessionKey, "after-io"));
    assert.equal(h.sessions[0]!.selected()?.id, "after-io");
  } finally {
    await h.dispose();
  }
});

test("MR6: concurrent admissions dedupe reload; edits during reload cannot be certified as applied", async () => {
  const h = runtimeHarness();
  try {
    const opened = await h.open();
    await h.agentService.service.setModel(selection(opened.sessionKey));
    h.executor.setFile(modelsPath, modelsText("first"));
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.onReload(async () => {
      entered();
      await barrier;
    });
    const before = h.sessions[0]!.commands.length;
    const one = h.agentService.service.setModel(selection(opened.sessionKey, "last"));
    const two = h.agentService.service.setModel(selection(opened.sessionKey, "last"));
    await waiting;
    h.executor.setFile(modelsPath, modelsText("last"));
    release();
    await Promise.all([one, two]);
    assert.equal(
      h.sessions[0]!.commands.slice(before).filter((c) => c.type === "reload").length,
      2,
    );
    assert.equal(h.sessions[0]!.selected()?.id, "last");
  } finally {
    await h.dispose();
  }
});

test("MR7: dispose/close fences late reload ACK and never writes to the retired process", async () => {
  const h = runtimeHarness();
  try {
    const opened = await h.open();
    await h.agentService.service.setModel(selection(opened.sessionKey));
    h.executor.setFile(modelsPath, modelsText("new"));
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.onReload(async () => {
      entered();
      await barrier;
    });
    const pending = h.agentService.service.setModel(selection(opened.sessionKey, "new"));
    const rejected = assert.rejects(pending, /changed|closed|disposed|exited/);
    await waiting;
    await h.agentService.service.closeSession(opened.sessionKey);
    const count = h.sessions[0]!.commands.length;
    release();
    await rejected;
    assert.equal(h.sessions[0]!.commands.length, count);
    assert.equal((await h.configApi.reloadRunningSessions(LOCAL)).reloaded, 0);
  } finally {
    await h.dispose();
  }
});

test("MR9: restored/recycled processes register fresh identities; read-only snapshots never receive writes", async () => {
  const h = runtimeHarness();
  try {
    const restored = await h.restore("/sessions/saved.jsonl");
    const locked = await h.restore("/sessions/locked.jsonl", "/locked", true);
    assert.equal(locked.readonly, true);
    assert.equal(h.sessions.length, 1);
    await assert.rejects(
      h.agentService.service.setModel(selection(locked.sessionKey)),
      /read-only/,
    );
    h.executor.setFile(modelsPath, modelsText("restored"));
    await h.agentService.service.setModel(selection(restored.sessionKey, "restored"));
    const old = h.sessions[0]!;
    await old.process.dispose();
    const retiredCommands = old.commands.length;
    assert.equal((await h.configApi.reloadRunningSessions(LOCAL)).reloaded, 0);
    h.executor.setFile(modelsPath, modelsText("recycled"));
    await h.agentService.service.setModel(selection(restored.sessionKey, "recycled"));
    assert.equal(h.sessions.length, 2);
    assert.equal(h.sessions[1]!.selected()?.id, "recycled");
    assert.equal(old.commands.length, retiredCommands);
    h.configApi.dispose();
    const before = h.sessions[1]!.commands.length;
    await assert.rejects(
      h.agentService.service.setModel(selection(restored.sessionKey, "recycled")),
      /disposed|closed/,
    );
    assert.equal(h.sessions[1]!.commands.length, before);
  } finally {
    await h.dispose();
  }
});

test("MR8: model facts use the same config owner's content admission without watch epoch/session reload", async () => {
  const h = runtimeHarness();
  const facts = createNekModelFactsSource(h.configApi);
  try {
    assert.equal((await facts.read()).models[0]?.modelId, "old");
    // The spawn-time content is proven, so the first read costs no reload; only the edit does.
    assert.equal(h.control.commands.filter((c) => c.type === "reload").length, 0);
    h.executor.setFile(modelsPath, modelsText("fresh"));
    assert.equal((await facts.read()).models[0]?.modelId, "fresh");
    const afterEdit = h.control.commands.filter((c) => c.type === "reload").length;
    assert.equal(afterEdit, 1, "a content change still needs exactly one reload");
    await facts.read();
    assert.equal(h.control.commands.filter((c) => c.type === "reload").length, afterEdit);
    h.executor.setFile(modelsPath, modelsText("retry"));
    h.failControl("control reload failed");
    await assert.rejects(facts.read(), /control reload failed/);
    h.failControl();
    assert.equal((await facts.read()).models[0]?.modelId, "retry");
    assert.equal(h.sessions.length, 0);
  } finally {
    facts.dispose();
    await h.dispose();
  }
});
