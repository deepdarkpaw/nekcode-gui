import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  AGENT_DIR,
  createHarness,
  expectNekError,
  LOCAL,
  PROJECT,
  PROJECT_DIR,
} from "./nekConfigApiHarness.js";

const userDir = join(AGENT_DIR, "agents");
const userFile = (name: string) => join(userDir, name);
const projectFile = (name: string) => join(PROJECT_DIR, "agents", name);
const markdown = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: Reviews diffs\n${extra}---\n`;

test("AC-1 edits, renames and removes the chosen mismatched file, even with a same-name sibling", async () => {
  const path = userFile("reviewer.md");
  const sibling = userFile("code-reviewer.md");
  const harness = createHarness({
    localFiles: {
      [path]: markdown('" code-reviewer "'),
      [sibling]: markdown("code-reviewer", "custom: sibling\n"),
    },
  });
  const { api, local } = harness;
  const entry = (await api.listAgentPresets(LOCAL)).entries.find((item) => item.path === path);
  assert.ok(entry);
  assert.equal(entry.preset.name, "code-reviewer");
  const saved = await api.saveAgentPreset(
    LOCAL,
    "global",
    { ...entry.preset, description: "New description" },
    { revision: entry.revision },
  );
  assert.match(local.files.get(path) ?? "", /description: New description/u);
  assert.equal(local.files.get(sibling), markdown("code-reviewer", "custom: sibling\n"));
  const renamed = await api.saveAgentPreset(
    LOCAL,
    "global",
    { ...entry.preset, name: "team/reviewer", description: "New description" },
    saved,
  );
  assert.match(local.files.get(path) ?? "", /name: team\/reviewer/u);
  assert.equal(
    (await api.listAgentPresets(LOCAL)).entries.find((item) => item.path === path)?.preset.name,
    "team/reviewer",
  );
  await api.deleteAgentPreset(LOCAL, "global", path, renamed);
  assert.equal(local.files.has(path), false);
  assert.equal(local.files.has(sibling), true);
});

test("AC-1 creation refuses occupied filenames, whether valid or broken, and never overwrites", async () => {
  const validPath = userFile("reviewer.md");
  const badPath = userFile("broken.md");
  const invalid = "broken YAML\n";
  const { api, local } = createHarness({
    localFiles: { [validPath]: markdown("different"), [badPath]: invalid },
  });
  for (const [name, path] of [
    ["reviewer", validPath],
    ["broken", badPath],
  ] as const) {
    const error = await expectNekError(
      () =>
        api.saveAgentPreset(LOCAL, "global", { name, description: "New" }, { revision: "absent" }),
      "validation",
    );
    assert.ok(error.message.includes(path));
  }
  assert.equal(local.files.get(validPath), markdown("different"));
  assert.equal(local.files.get(badPath), invalid);
  assert.equal(local.writes.length, 0);
});

test("AC-2 a canonical rename checks destination occupancy without reading its frontmatter", async () => {
  const path = userFile("reviewer.md");
  const destination = userFile("renamed.md");
  const { api, local } = createHarness({
    localFiles: { [path]: markdown("reviewer"), [destination]: "invalid\n" },
  });
  const entry = (await api.listAgentPresets(LOCAL)).entries.find((item) => item.path === path);
  assert.ok(entry);
  const error = await expectNekError(
    () =>
      api.saveAgentPreset(
        LOCAL,
        "global",
        { ...entry.preset, name: "renamed" },
        { revision: entry.revision },
      ),
    "validation",
  );
  assert.ok(error.message.includes(destination));
  assert.equal(local.files.get(path), markdown("reviewer"));
  assert.equal(local.files.get(destination), "invalid\n");
});

test("AC-1 project file revisions cannot edit or delete a user file, even with the same content", async () => {
  const user = userFile("reviewer.md");
  const project = projectFile("reviewer.md");
  const { api, local } = createHarness({
    localFiles: { [user]: markdown("reviewer"), [project]: markdown("reviewer") },
  });
  const entry = (await api.listAgentPresets(LOCAL, PROJECT)).entries.find(
    (item) => item.path === project,
  );
  assert.ok(entry);
  await expectNekError(
    () => api.saveAgentPreset(LOCAL, "global", entry.preset, { revision: entry.revision }),
    "validation",
  );
  await expectNekError(
    () => api.deleteAgentPreset(LOCAL, "global", user, { revision: entry.revision }),
    "conflict",
  );
  assert.equal(local.writes.length, 0);
});

test("AC-3 accepts the trimmed nek fields and reports each rejected document with the core reason", async () => {
  const good = userFile("a.md");
  const cases = [
    ["missing.md", "No YAML", 'frontmatter needs both "name" and "description"'],
    ["blank.md", markdown('"  "'), 'frontmatter needs both "name" and "description"'],
    ["scalar.md", "---\ntrue\n---\n", "frontmatter must be a mapping"],
    [
      "thinking.md",
      markdown("bad", "thinking: NORMAL\n"),
      '"thinking" must be one of off, minimal, low, medium, high, xhigh, max',
    ],
    [
      "fraction.md",
      markdown("bad", "context_window: 1.5\n"),
      '"context_window" must be a positive integer',
    ],
    [
      "unsafe.md",
      markdown("bad", "context_window: 9007199254740992\n"),
      '"context_window" must be a positive integer',
    ],
    [
      "quoted.md",
      markdown("bad", 'context_window: "123"\n'),
      '"context_window" must be a positive integer',
    ],
  ] as const;
  const goodText =
    '\ufeff---\rname: " dev/reviewer "\rdescription: " text "\rthinking: " xhigh "\rcontext_window: 9007199254740991\rmodel: " team/model "\r---\r\r Help. \r';
  const { api } = createHarness({
    localFiles: {
      [good]: goodText,
      ...Object.fromEntries(cases.map(([name, content]) => [userFile(name), content])),
    },
  });
  const view = await api.listAgentPresets(LOCAL);
  const user = view.entries.filter((entry) => entry.source === "user");
  assert.equal(user.length, 1);
  assert.equal(user[0]?.preset.name, "dev/reviewer");
  assert.equal(user[0]?.preset.description, "text");
  assert.equal(user[0]?.preset.thinking, "xhigh");
  assert.equal(user[0]?.preset.contextWindow, Number.MAX_SAFE_INTEGER);
  assert.equal(user[0]?.preset.model, "team/model");
  assert.equal(user[0]?.preset.instructions, "Help.");
  assert.deepEqual(
    view.diagnostics,
    cases.map(([name, , reason]) => ({
      file: userFile(name),
      severity: "error",
      message: `${userFile(name)}: ${reason}`,
    })),
  );
});

test("AC-4 follows readdir order without sorting, then applies project > user > built-in", async () => {
  const first = userFile("z.md");
  const last = userFile("b.md");
  const project = projectFile("project.md");
  const harness = createHarness({
    localFiles: {
      [first]: markdown("explorer"),
      [last]: markdown("explorer"),
      [project]: markdown("explorer"),
      [userFile("ignored.MD")]: markdown("explorer"),
      [userFile(join("nested", "nested.md"))]: markdown("explorer"),
    },
  });
  const explorer = (view: Awaited<ReturnType<typeof harness.api.listAgentPresets>>) =>
    view.entries.filter((item) => item.preset.name === "explorer");
  const global = explorer(await harness.api.listAgentPresets(LOCAL));
  assert.deepEqual(
    global.map(({ path, overriddenBy }) => [path, overriddenBy]),
    [
      [undefined, last],
      [first, last],
      [last, undefined],
    ],
  );
  const active = explorer(await harness.api.listAgentPresets(LOCAL, PROJECT));
  assert.deepEqual(
    active.map(({ path, overriddenBy }) => [path, overriddenBy]),
    [
      [undefined, project],
      [first, project],
      [last, project],
      [project, undefined],
    ],
  );
  assert.ok(harness.control.commands.some((command) => command.type === "get_project_trust"));
  harness.control.projectTrusted = false;
  const inactive = explorer(await harness.api.listAgentPresets(LOCAL, PROJECT));
  assert.equal(inactive.find((entry) => entry.path === first)?.overriddenBy, last);
  assert.equal(inactive.find((entry) => entry.path === project)?.untrusted, true);
});

test("AC-5 tools are resolved like nek but defaults and derived lists never leak into writes", async () => {
  const readonly = userFile("readonly.md");
  const explicit = userFile("explicit.md");
  const defaults = userFile("defaults.md");
  const body = "\r\n\r\n Detail.  \r\n\r\n";
  const header = markdown(
    "readonly",
    'readonly: true\ntools: [write, 7, " read ", "  "]\ndisallowed_tools: " grep, web_search "\nunknown: keep\n',
  ).trimEnd();
  const { api, local } = createHarness({
    localFiles: {
      [readonly]: `${header}${body}`,
      [explicit]: markdown(
        "explicit",
        'tools: "bash, read, , grep, read"\ndisallowed_tools: [grep, 37]\n',
      ),
      [defaults]: markdown("defaults", "disallowed_tools: write\n"),
    },
  });
  const entries = (await api.listAgentPresets(LOCAL)).entries;
  const ro = entries.find((entry) => entry.path === readonly);
  const def = entries.find((entry) => entry.path === defaults);
  assert.ok(ro && def);
  assert.deepEqual(ro.preset.tools, ["write", "read"]);
  assert.deepEqual(ro.effectiveTools, ["read", "find", "ls", "ast_grep"]);
  assert.deepEqual(entries.find((entry) => entry.path === explicit)?.effectiveTools, [
    "bash",
    "read",
    "read",
  ]);
  assert.deepEqual(def.effectiveTools, [
    "read",
    "bash",
    "edit",
    "grep",
    "find",
    "ls",
    "ast_grep",
    "todo_write",
    "web_search",
  ]);
  for (const entry of [ro, def]) {
    await api.saveAgentPreset(
      LOCAL,
      "global",
      { ...entry.preset, description: "Edited" },
      { revision: entry.revision },
    );
  }
  const roWritten = local.files.get(readonly) ?? "";
  assert.match(roWritten, /^disallowed_tools: " grep, web_search "$/mu);
  assert.match(roWritten, /^unknown: keep$/mu);
  assert.ok(roWritten.endsWith(body));
  assert.doesNotMatch(local.files.get(defaults) ?? "", /^tools:|^readonly:/mu);
});

test("AC-6 built-ins mirror the v0.5.1 flags, full descriptions, tools and explorer instructions", async () => {
  const { api } = createHarness();
  const { entries } = await api.listAgentPresets(LOCAL);
  const [general, explorer] = entries;
  assert.deepEqual(
    entries.map((entry) => entry.preset.name),
    ["generalPurpose", "explorer"],
  );
  assert.deepEqual(general?.preset, {
    name: "generalPurpose",
    description:
      "handles substantial, clearly bounded general work that has already been determined suitable for delegation. It can edit files and run commands. Uncertain search results alone are not enough reason to use it.",
    readonly: false,
    isBackground: false,
    autonomous: false,
    tools: [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "ast_grep",
      "todo_write",
      "web_search",
    ],
    disallowedTools: [],
  });
  assert.deepEqual(explorer?.preset, {
    name: "explorer",
    description:
      "handles clearly bounded, substantial codebase exploration that has already been determined suitable for delegation. It can find files by patterns, search keywords, or map code structure. State the scope and desired depth: quick, medium, or very thorough.",
    readonly: true,
    isBackground: false,
    autonomous: true,
    tools: ["read", "grep", "find", "ls", "ast_grep", "web_search"],
    disallowedTools: [],
    instructions:
      "Explore the codebase to answer the question in the task prompt. You cannot edit files: report findings, file paths, and code structure instead of changing anything. State the desired depth in your answer: quick, medium, or very thorough.",
  });
});
