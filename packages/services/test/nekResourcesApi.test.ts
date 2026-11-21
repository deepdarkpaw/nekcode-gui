import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  NekListResourcesResult,
  NekResourceInfo,
  NekResourceType,
  NekRpcCommandOfType,
  NekRpcCommandType,
  NekRpcResponseDataFor,
} from "@zcode/shared/nek-protocol";
import {
  createMemoryNekConfigHostExecutor,
  createWorkspaceConfigService,
  NekConfigApi,
} from "../src/nek-config-api/index.js";
import { FakeControlClient, LOCAL, REMOTE } from "./nekConfigApiHarness.js";

const CWD = "/work/project";
const LOCAL_AGENT = "/home/l/.nek/agent";
const REMOTE_AGENT = "/opt/nek/agent";

function resource(
  resourceType: NekResourceType,
  name: string,
  root: string,
  scope: NekResourceInfo["scope"],
  enabled = true,
): NekResourceInfo {
  return {
    resourceType,
    name,
    scope,
    enabled,
    path: `${root}/${resourceType}/${resourceType === "skills" ? `${name}/SKILL.md` : `${name}.md`}`,
    toggleable: true,
    source: "local",
  };
}

class ResourcesControl extends FakeControlClient {
  entries: NekResourceInfo[] = [];
  trusted = true;
  failure?: string;
  readonly resourcesCalls: Array<{ type: string; cwd?: string; path?: string; enabled?: boolean }> =
    [];

  override async call<C extends NekRpcCommandType>(
    command: NekRpcCommandOfType<C>,
  ): Promise<NekRpcResponseDataFor<C>> {
    if (command.type === "list_resources" || command.type === "set_resource_enabled") {
      this.resourcesCalls.push(command);
      if (this.failure) throw new Error(this.failure);
      if (command.type === "list_resources") {
        const result: NekListResourcesResult = {
          projectTrusted: this.trusted,
          diagnostics: [{ type: "warning", message: "from nek" }],
          resources: this.entries.filter(
            (entry) =>
              entry.resourceType === command.resourceType &&
              (entry.scope !== "project" || this.trusted),
          ),
        };
        return result as NekRpcResponseDataFor<C>;
      }
      const entry = this.entries.find((item) => item.path === command.path);
      if (!entry?.toggleable) throw new Error("not toggleable");
      entry.enabled = command.enabled;
      return {
        settingsScope: entry.scope === "project" ? "project" : "global",
        enabled: entry.enabled,
      } as NekRpcResponseDataFor<C>;
    }
    return super.call(command);
  }
}

function setup(autoReload = false) {
  const local = createMemoryNekConfigHostExecutor({ home: "/home/l", agentDir: LOCAL_AGENT });
  const remote = createMemoryNekConfigHostExecutor({ home: "/home/r", agentDir: REMOTE_AGENT });
  const localControl = new ResourcesControl();
  const remoteControl = new ResourcesControl();
  const reloaded: string[] = [];
  const api = new NekConfigApi({
    hosts: {
      executor: (target) => (target.kind === "remote" ? remote : local),
      listTargets: async () => [],
    },
    config: { autoReload },
    control: async ({ target }) => (target.kind === "remote" ? remoteControl : localControl),
    sessions: {
      sessions: (target) =>
        [CWD, "/unrelated"].map((cwd) => ({
          sessionKey: cwd,
          cwd,
          busy: false,
          call: (async () => {
            reloaded.push(`${target.kind}:${cwd}`);
            return { deferred: false, diagnostics: [] };
          }) as never,
        })),
    },
  });
  return { local, remote, localControl, remoteControl, api, reloaded };
}

for (const resourceType of ["skills", "prompts"] as const) {
  test(`${resourceType}: only nek's catalog is used, including disabled, absent project and explicit entries`, async (t) => {
    const h = setup();
    t.after(() => h.api.dispose());
    const global = resource(resourceType, "global", LOCAL_AGENT, "user", false);
    const project = resource(resourceType, "project", `${CWD}/.nek`, "project");
    const explicit = resource(resourceType, "explicit", "/somewhere", "temporary");
    h.local.setFile(`/home/l/.agents/${resourceType}/ignored.md`, "legacy, not an RPC entry");
    h.localControl.entries = [global, project, explicit];
    const query = { resourceType, cwd: CWD };
    assert.deepEqual(await h.api.listConfigResources(LOCAL, query), {
      resources: [global, project, explicit],
      projectTrusted: true,
      diagnostics: [{ type: "warning", message: "from nek" }],
      roots: { global: `${LOCAL_AGENT}/${resourceType}`, project: `${CWD}/.nek/${resourceType}` },
    });
    h.localControl.trusted = false;
    assert.deepEqual((await h.api.listConfigResources(LOCAL, query)).resources, [global, explicit]);
    await assert.rejects(
      h.api.createResource(LOCAL, {
        ...query,
        scope: "project",
        name: "new",
        description: "A description",
        content: "Body",
      }),
      /trusted workspace/u,
    );
    h.localControl.failure = "permission denied from nek";
    await assert.rejects(h.api.listConfigResources(LOCAL, query), /permission denied from nek/u);
    await assert.rejects(
      h.api.setResourceEnabled(LOCAL, { ...query, path: global.path, enabled: true }),
      /permission denied from nek/u,
    );
    assert.equal(h.local.writes.length, 0);
  });

  test(`${resourceType}: a remote toggle uses its control process and reloads only its affected sessions`, async (t) => {
    const h = setup(true);
    t.after(() => h.api.dispose());
    const local = resource(resourceType, "project", `${CWD}/.nek`, "project");
    const remote = { ...local, enabled: false };
    h.localControl.entries = [local];
    h.remoteControl.entries = [remote];
    const query = { cwd: CWD, resourceType };
    const notified = new Promise<void>((resolve) => h.api.onReloadResult(REMOTE, () => resolve()));
    assert.equal(
      (await h.api.listConfigResources(REMOTE, query)).roots.global,
      `${REMOTE_AGENT}/${resourceType}`,
    );
    assert.deepEqual(
      await h.api.setResourceEnabled(REMOTE, { ...query, path: remote.path, enabled: true }),
      { settingsScope: "project", enabled: true },
    );
    await notified;
    assert.deepEqual(h.reloaded, [`remote:${CWD}`]);
    assert.deepEqual(h.remoteControl.resourcesCalls, [
      { type: "list_resources", ...query },
      { type: "set_resource_enabled", ...query, path: remote.path, enabled: true },
    ]);
    assert.deepEqual(h.localControl.resourcesCalls, []);
    assert.equal(h.remote.writes.length, 0, "override is written by CLI, not by the executor");
  });
}

test("managed Markdown writes stay on the target, retain template frontmatter and never overwrite a new file", async (t) => {
  const h = setup();
  t.after(() => h.api.dispose());
  const input = {
    resourceType: "prompts",
    cwd: CWD,
    scope: "project",
    name: "review",
    content: "---\nargument-hint: '[scope]'\n---\nReview $1",
  } as const;
  const prompt = resource("prompts", "review", `${CWD}/.nek`, "project");
  await h.api.createResource(REMOTE, input);
  assert.equal(h.remote.files.get(prompt.path), input.content);
  assert.equal(h.local.files.has(prompt.path), false);
  await assert.rejects(h.api.createResource(REMOTE, input), /already exists/u);
  await assert.rejects(
    h.api.createResource(REMOTE, { ...input, name: "../outside" }),
    /resource name/u,
  );
  h.remoteControl.entries.push(prompt);
  const file = { ...input, path: prompt.path };
  const before = await h.api.readPromptTemplate(REMOTE, file);
  await h.api.writePromptTemplate(REMOTE, {
    ...file,
    revision: before.revision,
    content: "Plain Markdown with $ARGUMENTS",
  });
  await assert.rejects(
    h.api.writePromptTemplate(REMOTE, { ...file, revision: before.revision, content: "outdated" }),
    /modified externally/u,
  );
  await h.api.deleteResource(REMOTE, file);
  assert.equal(h.remote.files.has(prompt.path), false);
});

test("file mutations reject linked directories and explicit resources; workspace RPC stays on its execution target", async (t) => {
  const h = setup();
  t.after(() => h.api.dispose());
  const refs = { resourceType: "skills", cwd: CWD } as const;
  const explicit = resource("skills", "external", "/elsewhere", "temporary");
  const linked = resource("skills", "linked", `${CWD}/.nek`, "project");
  h.localControl.entries = [explicit, linked];
  h.local.setFile(linked.path, "body");
  const actualKind = h.local.resourceEntryKind;
  h.local.resourceEntryKind = (path) =>
    path === `${CWD}/.nek/skills/linked` ? Promise.resolve("other") : actualKind(path);
  const workspace = createWorkspaceConfigService(h.api);
  assert.equal(
    (await workspace.callConfig("listConfigResources", refs)).roots.global,
    `${LOCAL_AGENT}/skills`,
  );
  await assert.rejects(
    workspace.callConfig("deleteResource", { ...refs, path: explicit.path }),
    (error: { message?: string }) => /not managed here/u.test(error.message ?? ""),
  );
  await assert.rejects(
    workspace.callConfig("deleteResource", { ...refs, path: linked.path }),
    (error: { message?: string }) => /not a regular resource directory/iu.test(error.message ?? ""),
  );
  assert.equal(h.local.files.has(linked.path), true);
  assert.deepEqual(h.remoteControl.resourcesCalls, []);
});
