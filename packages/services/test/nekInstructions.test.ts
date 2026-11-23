import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { AGENT_DIR, createHarness, expectNekError, LOCAL, PROJECT } from "./nekConfigApiHarness.js";

const ref = (dir: string, filename: string) => ({ path: join(dir, filename), filename });

test("AC-7 edits a project with only CLAUDE.md instead of creating AGENTS.md", async () => {
  const { path } = ref(PROJECT, "CLAUDE.md");
  const { api, local } = createHarness({ localFiles: { [path]: "\ufeffOriginal" } });
  const document = await api.readInstructions(LOCAL, "project", PROJECT);
  assert.equal(document.filename, "CLAUDE.md");
  assert.equal(document.content, "Original");
  assert.deepEqual(document.ignored, []);
  await api.writeInstructions(LOCAL, "project", "Edited", {
    path: document.path,
    revision: document.revision,
    cwd: PROJECT,
  });
  assert.equal(local.files.get(path), "\ufeffEdited");
  assert.equal(local.files.has(join(PROJECT, "AGENTS.md")), false);
});

test("AC-7 the global override wins and every ignored candidate is shown in priority order", async () => {
  const filenames = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
  const { api, local } = createHarness({
    localFiles: Object.fromEntries(
      filenames
        .slice()
        .reverse()
        .map((name) => [join(AGENT_DIR, name), name]),
    ),
  });
  const document = await api.readInstructions(LOCAL, "global");
  assert.equal(document.path, join(AGENT_DIR, "AGENTS.override.md"));
  assert.equal(document.content, "AGENTS.override.md");
  assert.deepEqual(
    document.ignored,
    filenames.slice(1).map((filename) => ref(AGENT_DIR, filename)),
  );
  await api.writeInstructions(LOCAL, "global", "Override", {
    path: document.path,
    revision: document.revision,
  });
  assert.equal(local.files.get(document.path), "Override");
  assert.equal(local.files.get(join(AGENT_DIR, "AGENTS.md")), "AGENTS.md");
});

test("AC-7 ignores an instruction directory and creates AGENTS.md only when there is no active candidate", async () => {
  const { api, local } = createHarness({
    localFiles: { [join(PROJECT, "AGENTS.override.md", "nested")]: "not a file" },
  });
  const document = await api.readInstructions(LOCAL, "project", PROJECT);
  assert.equal(document.path, join(PROJECT, "AGENTS.md"));
  assert.equal(document.content, "");
  assert.equal(document.revision, "absent");
  await api.writeInstructions(LOCAL, "project", "New", {
    path: document.path,
    revision: document.revision,
    cwd: PROJECT,
  });
  assert.equal(local.files.get(document.path), "New");
  assert.equal(local.files.has(join(PROJECT, ".nek", "AGENTS.md")), false);
});

test("AC-7 refuses to save a draft if a different winner appears even with identical content and revision", async () => {
  const claude = join(PROJECT, "CLAUDE.md");
  const agents = join(PROJECT, "AGENTS.md");
  const { api, local } = createHarness({ localFiles: { [claude]: "Identical" } });
  const document = await api.readInstructions(LOCAL, "project", PROJECT);
  local.setFile(agents, "Identical");
  await expectNekError(
    () =>
      api.writeInstructions(LOCAL, "project", "Draft", {
        path: document.path,
        revision: document.revision,
        cwd: PROJECT,
      }),
    "conflict",
  );
  assert.equal(local.files.get(agents), "Identical");
  assert.equal(local.files.get(claude), "Identical");
});

test("AC-7 lists readable ancestors root-first, skipping the duplicate global context", async () => {
  const root = join(AGENT_DIR, "repo");
  const parent = join(root, "module");
  const cwd = join(parent, "subdir");
  const { api } = createHarness({
    localFiles: {
      [join(AGENT_DIR, "AGENTS.md")]: "Global",
      [join(root, "CLAUDE.MD")]: "Root",
      [join(parent, "AGENTS.override.md")]: "Parent override",
      [join(parent, "AGENTS.md")]: "Parent rules",
      [join(cwd, "CLAUDE.md")]: "Local rules",
    },
  });
  const document = await api.readInstructions(LOCAL, "project", cwd);
  assert.deepEqual(document.ancestors, [ref(root, "CLAUDE.MD"), ref(parent, "AGENTS.override.md")]);
  assert.equal(document.filename, "CLAUDE.md");
});

test("AC-7 a nested linked worktree shadows only the main repository candidate with the same selected name", async () => {
  const outer = join(process.cwd(), ".tmp", "linked-fixture");
  const main = join(outer, "main");
  const worktree = join(main, ".worktree", "feature");
  const cwd = join(worktree, "src");
  const gitDir = join(main, ".git", "worktrees", "feature");
  const mainContext = ref(main, "AGENTS.md");
  const worktreeContext = ref(worktree, "AGENTS.md");
  const outerContext = ref(outer, "CLAUDE.md");
  const { api, local } = createHarness({
    localFiles: {
      [join(worktree, ".git")]: "gitdir: ../../.git/worktrees/feature\n",
      [join(gitDir, "HEAD")]: "ref: refs/heads/feature\n",
      [join(gitDir, "commondir")]: "../..\n",
      [outerContext.path]: "Inherited",
      [mainContext.path]: "Main",
      [worktreeContext.path]: "Worktree",
    },
  });
  assert.deepEqual((await api.readInstructions(LOCAL, "project", cwd)).ancestors, [
    outerContext,
    worktreeContext,
  ]);
  const override = ref(worktree, "AGENTS.override.md");
  local.setFile(override.path, "Override");
  assert.deepEqual((await api.readInstructions(LOCAL, "project", cwd)).ancestors, [
    outerContext,
    mainContext,
    override,
  ]);
});
