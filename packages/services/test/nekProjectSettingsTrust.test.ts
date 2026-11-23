import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  AGENT_DIR,
  LOCAL,
  PROJECT,
  PROJECT_DIR,
  createHarness,
  expectNekError,
  readJson,
} from "./nekConfigApiHarness.js";

const GLOBAL_SETTINGS = join(AGENT_DIR, "settings.json");
const PROJECT_SETTINGS = join(PROJECT_DIR, "settings.json");
const RESOURCE = { kind: "settings", path: PROJECT_SETTINGS } as const;

function fixture() {
  const h = createHarness({
    localFiles: {
      [GLOBAL_SETTINGS]: JSON.stringify({
        shellPath: "global-shell",
        enabledModels: ["global/model"],
      }),
      [PROJECT_SETTINGS]: JSON.stringify({
        shellPath: "project-shell",
        enabledModels: ["project/model"],
      }),
    },
  });
  h.control.projectResources = [RESOURCE];
  return h;
}

test("PT-6 ignored project settings are marked, excluded from effective, and not writable", async (t) => {
  const h = fixture();
  t.after(() => h.api.dispose());
  // No stored decision + ask is untrusted for configuration reads, without opening a session.
  const project = await h.api.readSettings(LOCAL, "project", PROJECT);
  assert.equal(project.projectTrusted, false);
  assert.equal(project.values.shellPath, "project-shell", "raw values are for inspection only");
  assert.equal(project.effective.shellPath, "global-shell");
  const workspaceGlobal = await h.api.readSettings(LOCAL, "global", PROJECT);
  assert.equal(workspaceGlobal.projectTrusted, false);
  assert.equal(workspaceGlobal.effective.shellPath, "global-shell");
  const error = await expectNekError(
    () =>
      h.api.patchSettings(
        LOCAL,
        "project",
        { shellPath: "changed" },
        { cwd: PROJECT, revision: project.revision },
      ),
    "validation",
  );
  assert.match(error.message, /Trust this project/);
  assert.deepEqual(h.local.writes, []);

  h.control.projectTrusted = true;
  await h.api.patchSettings(
    LOCAL,
    "project",
    { shellPath: "changed" },
    { cwd: PROJECT, revision: project.revision },
  );
  const trustedView = await h.api.readSettings(LOCAL, "project", PROJECT);
  assert.equal(trustedView.projectTrusted, true);
  assert.equal(trustedView.effective.shellPath, "changed");
});

test("PT-6 does not parse ignored project settings into a global effective view", async (t) => {
  const h = fixture();
  t.after(() => h.api.dispose());
  h.control.projectTrusted = false;
  h.local.setFile(PROJECT_SETTINGS, "invalid json");
  const view = await h.api.readSettings(LOCAL, "global", PROJECT);
  assert.equal(view.projectTrusted, false);
  assert.equal(view.effective.shellPath, "global-shell");
  assert.deepEqual(view.diagnostics, []);
});

for (const policy of ["ask", "always", "never"] as const) {
  test(`PT-8 model scope chooses the same layer as effective settings under '${policy}'`, async (t) => {
    const h = fixture();
    t.after(() => h.api.dispose());
    h.control.defaultProjectTrust = policy;
    const trusted = policy === "always";
    const current = await h.api.readSettings(LOCAL, "project", PROJECT);
    assert.equal(current.projectTrusted, trusted);
    const expectedPatterns = [trusted ? "project/model" : "global/model"];
    await h.api.saveModelScope(LOCAL, ["next/model"], { cwd: PROJECT, expectedPatterns });
    assert.deepEqual(
      (readJson(h.local, GLOBAL_SETTINGS) as { enabledModels: string[] }).enabledModels,
      trusted ? ["global/model"] : ["next/model"],
    );
    assert.deepEqual(
      (readJson(h.local, PROJECT_SETTINGS) as { enabledModels: string[] }).enabledModels,
      trusted ? ["next/model"] : ["project/model"],
    );
  });
}
