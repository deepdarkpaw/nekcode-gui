import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { NekSettingsPatch } from "@zcode/shared/nek-protocol";
import {
  AGENT_DIR,
  LOCAL,
  PROJECT,
  PROJECT_DIR,
  createHarness,
  expectNekError,
  readJson,
} from "./nekConfigApiHarness.js";

const SETTINGS = join(AGENT_DIR, "settings.json");
const PROJECT_SETTINGS = join(PROJECT_DIR, "settings.json");

for (const scope of ["global", "project"] as const) {
  test(`SR-1 rejects invalid compaction.content before writing ${scope} settings`, async (t) => {
    const { api, local } = createHarness();
    t.after(() => api.dispose());
    const cwd = scope === "project" ? PROJECT : undefined;
    const { revision, path } = await api.readSettings(LOCAL, scope, cwd);
    const cases = [
      [[], "", /object/],
      [false, "", /object/],
      ["content", "", /object/],
      [{ typo: true }, ".typo", /unknown/],
      [{ pruneToolResults: "false" }, ".pruneToolResults", /boolean/],
      [{ toolResultMaxChars: 0 }, ".toolResultMaxChars", />= 256/],
      [{ toolErrorMaxChars: 255 }, ".toolErrorMaxChars", />= 256/],
      [{ toolArgumentMaxChars: 255.9 }, ".toolArgumentMaxChars", />= 256/],
      [{ thinkingMaxChars: 1.5 }, ".thinkingMaxChars", /safe integer >= 0/],
      [{ thinkingTotalMaxChars: -1 }, ".thinkingTotalMaxChars", /safe integer >= 0/],
      [
        { protectedRecentTokens: Number.MAX_SAFE_INTEGER + 1 },
        ".protectedRecentTokens",
        /safe integer >= 0/,
      ],
      [{ protectedToolResults: "6" }, ".protectedToolResults", /safe integer >= 0/],
    ] as const;
    for (const [content, suffix, message] of cases) {
      const error = await expectNekError(
        () =>
          api.patchSettings(LOCAL, scope, { compaction: { content } } as NekSettingsPatch, {
            revision,
            cwd,
          }),
        "validation",
      );
      assert.match(error.fieldErrors?.[`compaction.content${suffix}`] ?? "", message);
      assert.equal(local.files.has(path), false);
    }
    assert.deepEqual(local.writes, []);
  });
}

test("SR-1 accepts all exact content minima and safe integer maxima", async (t) => {
  const { api, local } = createHarness();
  t.after(() => api.dispose());
  const { revision } = await api.readSettings(LOCAL, "global");
  const content = {
    thinkingMaxChars: 0,
    thinkingTotalMaxChars: Number.MAX_SAFE_INTEGER,
    toolResultMaxChars: 256,
    toolErrorMaxChars: 256,
    toolArgumentMaxChars: 256,
    protectedRecentTokens: 0,
    protectedToolResults: 0,
    pruneToolResults: false,
  };
  await api.patchSettings(LOCAL, "global", { compaction: { content } }, { revision });
  assert.deepEqual(readJson(local, SETTINGS), { compaction: { content } });
});

test("SR-2 reports invalid values at the owning file and supports one-field resets", async (t) => {
  const global = { compaction: { content: { toolArgumentMaxChars: 0, pruneToolResults: null } } };
  const project = { compaction: { content: [] } };
  const { api, local } = createHarness({
    localFiles: {
      [SETTINGS]: JSON.stringify(global),
      [PROJECT_SETTINGS]: JSON.stringify(project),
    },
  });
  t.after(() => api.dispose());
  const read = await api.readSettings(LOCAL, "project", PROJECT);
  assert.deepEqual(read.diagnostics, [
    {
      file: PROJECT_SETTINGS,
      severity: "error",
      message: "compaction.content: expected an object",
    },
    {
      file: SETTINGS,
      severity: "error",
      message: "compaction.content.toolArgumentMaxChars: expected a safe integer >= 256",
    },
    {
      file: SETTINGS,
      severity: "error",
      message: "compaction.content.pruneToolResults: expected a boolean",
    },
  ]);
  assert.deepEqual(readJson(local, SETTINGS), global);
  assert.deepEqual(readJson(local, PROJECT_SETTINGS), project);

  await api.patchSettings(LOCAL, "project", { compaction: { content: null } } as NekSettingsPatch, {
    revision: read.revision,
    cwd: PROJECT,
  });
  let globalRead = await api.readSettings(LOCAL, "global");
  await api.patchSettings(
    LOCAL,
    "global",
    { compaction: { content: { toolArgumentMaxChars: null } } } as NekSettingsPatch,
    { revision: globalRead.revision },
  );
  globalRead = await api.readSettings(LOCAL, "global");
  assert.equal(globalRead.effective.compaction?.content?.toolArgumentMaxChars, 2000);
  assert.equal(
    globalRead.diagnostics.length,
    1,
    "a pre-existing null must not block an unrelated repair",
  );
  await api.patchSettings(
    LOCAL,
    "global",
    { compaction: { content: { pruneToolResults: null } } } as NekSettingsPatch,
    { revision: globalRead.revision },
  );
  assert.deepEqual((await api.readSettings(LOCAL, "global")).diagnostics, []);
  assert.deepEqual(readJson(local, SETTINGS), { compaction: { content: {} } });
});

test("SR-4 rejects non-safe or negative tokens and invalid addressable model overrides", async (t) => {
  const { api, local } = createHarness();
  t.after(() => api.dispose());
  const { revision } = await api.readSettings(LOCAL, "global");
  for (const [compaction, field] of [
    [{ reserveTokens: -1 }, "reserveTokens"],
    [{ keepRecentTokens: 1.5 }, "keepRecentTokens"],
    [{ reserveTokens: Number.MAX_SAFE_INTEGER + 1 }, "reserveTokens"],
    [{ modelOverrides: { "openrouter/org/model": [] } }, "modelOverrides.openrouter/org/model"],
    [
      { modelOverrides: { "provider/a.b": { keepRecentTokens: "0" } } },
      "modelOverrides.provider/a.b.keepRecentTokens",
    ],
  ] as const) {
    const error = await expectNekError(
      () => api.patchSettings(LOCAL, "global", { compaction } as NekSettingsPatch, { revision }),
      "validation",
    );
    assert.match(error.fieldErrors?.[`compaction.${field}`] ?? "", /safe integer|object/);
  }
  assert.equal(local.files.has(SETTINGS), false);
});

test("SR-4 addresses model overrides by exact key and does not validate unused content or map shape", async (t) => {
  const { api, local } = createHarness();
  t.after(() => api.dispose());
  let { revision } = await api.readSettings(LOCAL, "global");
  const compaction = {
    reserveTokens: 0,
    keepRecentTokens: Number.MAX_SAFE_INTEGER,
    modelOverrides: {
      "openrouter/org/model": {
        reserveTokens: 0,
        keepRecentTokens: 0,
        content: { toolResultMaxChars: 0 },
        extra: "keep",
      },
      "not-a-model-key": 19,
    },
  };
  ({ revision } = await api.patchSettings(LOCAL, "global", { compaction } as NekSettingsPatch, {
    revision,
  }));
  assert.deepEqual(readJson(local, SETTINGS), { compaction });
  await api.patchSettings(
    LOCAL,
    "global",
    { compaction: { modelOverrides: false } } as unknown as NekSettingsPatch,
    { revision },
  );
  assert.deepEqual(readJson(local, SETTINGS), {
    compaction: { ...compaction, modelOverrides: false },
  });
});

test("SR-5 round-trips each tool-list style and gets the catalogue from nek RPC", async (t) => {
  const { api, control, local } = createHarness();
  t.after(() => api.dispose());
  control.builtinTools = [
    { name: "read", description: "Read a file", defaultActive: true },
    { name: "powershell", description: "Run PowerShell", defaultActive: false },
  ];
  assert.deepEqual(await api.listBuiltinTools(LOCAL), control.builtinTools);
  assert.equal(control.commands[0]?.type, "list_builtin_tools");
  let read = await api.readSettings(LOCAL, "global");
  assert.equal(read.values.defaultTools, undefined);
  for (const defaultTools of [
    [],
    [" ", "\t"],
    ["read"],
    ["-read", "+powershell"],
    ["read", "  +future_tool ", "FutureTool", "-"],
  ]) {
    await api.patchSettings(LOCAL, "global", { defaultTools }, read);
    read = await api.readSettings(LOCAL, "global");
    assert.deepEqual(read.values.defaultTools, defaultTools);
    assert.deepEqual(read.effective.defaultTools, defaultTools);
    assert.deepEqual(readJson(local, SETTINGS), { defaultTools });
  }
});

test("SR-6 keeps provider settings nested and leaves unspecified SDK options unset", async (t) => {
  const { api, local } = createHarness();
  t.after(() => api.dispose());
  let read = await api.readSettings(LOCAL, "global");
  assert.deepEqual(read.defaults.retry, {
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2000,
    maxAgentDelayMs: 60000,
    provider: { maxRetryDelayMs: 60000 },
  });
  const retry = {
    maxRetries: 1.5,
    timeoutMs: "ignored top-level field",
    maxRetryDelayMs: "ignored top-level field",
    provider: { timeoutMs: 4000, maxRetries: 0, maxRetryDelayMs: 8000 },
  };
  await api.patchSettings(LOCAL, "global", { retry }, read);
  read = await api.readSettings(LOCAL, "global");
  assert.deepEqual(readJson(local, SETTINGS), { retry });
  assert.deepEqual(read.effective.retry?.provider, retry.provider);
  await api.patchSettings(LOCAL, "global", { retry: { provider: null } } as NekSettingsPatch, read);
  read = await api.readSettings(LOCAL, "global");
  assert.deepEqual(read.effective.retry?.provider, read.defaults.retry?.provider);
});

test("SR-6 applies legacy maxDelayMs only to the loaded projection, per file before merging", async (t) => {
  const global = { retry: { maxDelayMs: 100, provider: { maxRetries: 0, maxRetryDelayMs: 200 } } };
  const project = { retry: { maxDelayMs: 300 } };
  const { api, local } = createHarness({
    localFiles: {
      [SETTINGS]: JSON.stringify(global),
      [PROJECT_SETTINGS]: JSON.stringify(project),
    },
  });
  t.after(() => api.dispose());
  assert.equal(
    (await api.readSettings(LOCAL, "global")).effective.retry?.provider?.maxRetryDelayMs,
    200,
  );
  assert.deepEqual((await api.readSettings(LOCAL, "project", PROJECT)).effective.retry?.provider, {
    maxRetries: 0,
    maxRetryDelayMs: 300,
  });
  assert.deepEqual(readJson(local, PROJECT_SETTINGS), project);
});

test("SR-7 presents editable keys at the top level and keeps raw-only settings in extra", async (t) => {
  const raw = {
    defaultTools: [],
    retry: { enabled: false },
    theme: "dark",
    custom: { flag: true },
  };
  const { api, local } = createHarness({ localFiles: { [SETTINGS]: JSON.stringify(raw) } });
  t.after(() => api.dispose());
  const read = await api.readSettings(LOCAL, "global");
  assert.deepEqual(read.values, {
    defaultTools: [],
    retry: { enabled: false },
    extra: { theme: "dark", custom: { flag: true } },
  });
  await api.patchSettings(
    LOCAL,
    "global",
    { extra: { theme: null }, retry: { enabled: true } },
    read,
  );
  assert.deepEqual(readJson(local, SETTINGS), {
    defaultTools: [],
    retry: { enabled: true },
    custom: { flag: true },
  });
});

test("SR-8 rejects the values that fail nek's static getters before writing", async (t) => {
  const { api, local } = createHarness();
  t.after(() => api.dispose());
  const read = await api.readSettings(LOCAL, "global");
  for (const [patch, field] of [
    [{ httpIdleTimeoutMs: -0.2 }, "httpIdleTimeoutMs"],
    [{ httpIdleTimeoutMs: "  " }, "httpIdleTimeoutMs"],
    [{ httpIdleTimeoutMs: "Infinity" }, "httpIdleTimeoutMs"],
    [{ httpIdleTimeoutMs: true }, "httpIdleTimeoutMs"],
    [{ extra: { websocketConnectTimeoutMs: "never" } }, "websocketConnectTimeoutMs"],
    [{ httpProxy: 1 }, "httpProxy"],
    [{ compaction: { model: "bare-model" } }, "compaction.model"],
    [{ compaction: { model: "provider/my model" } }, "compaction.model"],
    [{ compaction: { thinkingLevel: "turbo" } }, "compaction.thinkingLevel"],
    [{ defaultTools: "read" }, "defaultTools"],
    [{ defaultTools: ["read", null] }, "defaultTools.1"],
    [{ enabledModels: ["a/b", true] }, "enabledModels.1"],
    [{ extra: { packages: [{ source: 2 }] } }, "packages.0"],
    [{ extra: { skills: { customDirectories: [1] } } }, "skills.customDirectories.0"],
    [{ extra: { sessionDir: 12 } }, "sessionDir"],
    [{ webSearch: [] }, "webSearch"],
    [{ webSearch: { provider: "other" } }, "webSearch.provider"],
    [{ webSearch: { provider: "exa", endpoint: "  " } }, "webSearch.endpoint"],
    [{ webSearch: { provider: "tavily", apiKey: "" } }, "webSearch.apiKey"],
    [{ webSearch: { numResults: 0 } }, "webSearch.numResults"],
    [{ webSearch: { numResults: 21 } }, "webSearch.numResults"],
    [{ webSearch: { numResults: 1.5 } }, "webSearch.numResults"],
  ] as const) {
    const error = await expectNekError(
      () => api.patchSettings(LOCAL, "global", patch as unknown as NekSettingsPatch, read),
      "validation",
    );
    assert.ok(error.fieldErrors?.[field], `${field}: ${error.message}`);
    assert.equal(local.files.has(SETTINGS), false);
  }
});

test("SR-8 accepts numeric-string and fractional timeouts, disabled, and the getter's permissive cases", async (t) => {
  const { api, local } = createHarness();
  t.after(() => api.dispose());
  let read = await api.readSettings(LOCAL, "global");
  for (const [httpIdleTimeoutMs, effective] of [
    ["  DiSaBlEd ", 0],
    [" 250.9 ", 250],
    [0.9, 0],
    ["0x100", 256],
    [0, 0],
  ] as const) {
    await api.patchSettings(LOCAL, "global", { httpIdleTimeoutMs }, read);
    read = await api.readSettings(LOCAL, "global");
    assert.equal(read.values.httpIdleTimeoutMs, httpIdleTimeoutMs);
    assert.equal(read.effective.httpIdleTimeoutMs, effective);
  }
  const looseValues = {
    transport: "future-transport",
    steeringMode: "future-mode",
    followUpMode: "",
    defaultThinkingLevel: "future-level",
    defaultTools: false,
    branchSummary: { reserveTokens: -1.25 },
  };
  await api.patchSettings(
    LOCAL,
    "global",
    {
      ...looseValues,
      extra: { websocketConnectTimeoutMs: "disabled", skills: { customDirectories: ["./skills"] } },
      compaction: { model: "provider/org/model", thinkingLevel: "max" },
      webSearch: { numResults: 1 },
    } as unknown as NekSettingsPatch,
    read,
  );
  assert.deepEqual(readJson(local, SETTINGS), {
    ...looseValues,
    httpIdleTimeoutMs: 0,
    websocketConnectTimeoutMs: "disabled",
    skills: { customDirectories: ["./skills"] },
    compaction: { model: "provider/org/model", thinkingLevel: "max" },
    webSearch: { numResults: 1 },
  });
  read = await api.readSettings(LOCAL, "global");
  assert.equal(read.effective.transport, "future-transport");
  assert.equal(read.effective.followUpMode, "one-at-a-time");
  assert.deepEqual(read.effective.extra?.skills, ["./skills"]);
  assert.deepEqual(read.diagnostics, []);
});

test("SR-8 projects legacy queueMode and websockets before applying defaults", async (t) => {
  const { api, local } = createHarness({
    localFiles: {
      [SETTINGS]: JSON.stringify({ queueMode: "all", websockets: false }),
    },
  });
  t.after(() => api.dispose());
  const read = await api.readSettings(LOCAL, "global");
  assert.deepEqual(read.values.extra, { queueMode: "all", websockets: false });
  assert.equal(read.effective.steeringMode, "all");
  assert.equal(read.effective.transport, "sse");
  assert.deepEqual(local.writes, []);
});
