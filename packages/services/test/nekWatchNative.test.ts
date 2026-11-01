import assert from "node:assert/strict";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NekWatchHub, type NekWatchChange } from "../src/nek-config-api/watch.js";
import { createLocalNekConfigHostExecutor } from "../src/nek-config-api/hostExecutor.js";
import { waitFor } from "./nekModelFactsFixture.js";

test("MW-N1: new .nek directory, atomic file rename and directory replacement stay observed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nek-model-watch-"));
  const global = join(root, "agent");
  const workspace = join(root, "project");
  const config = join(workspace, ".nek");
  await mkdir(global);
  await mkdir(workspace);
  await writeFile(join(global, "settings.json"), "{}");
  const executor = createLocalNekConfigHostExecutor({ home: root, agentDir: global, env: {} });
  const hub = new NekWatchHub({ debounceMs: 5, pollSeconds: 3600 });
  t.after(async () => {
    hub.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const changes: NekWatchChange[] = [];
  const stop = hub.subscribe(
    {
      key: "local",
      executor,
      local: true,
      dirs: [
        { path: global, scope: "global" },
        { path: config, scope: "project" },
      ],
    },
    (change) => changes.push(change),
  );
  await waitFor(() =>
    [global, config].every((path) =>
      changes.some((change) => change.file === path && change.revision === "watch-ready"),
    ),
  );
  changes.length = 0;
  await mkdir(config);
  const settings = join(config, "settings.json");
  await writeFile(settings, '{"defaultModel":"created"}');
  await waitFor(() => changes.some((change) => change.file === settings));
  changes.length = 0;
  await writeFile(`${settings}.tmp`, '{"defaultModel":"renamed"}');
  await rename(`${settings}.tmp`, settings);
  await waitFor(() => changes.some((change) => change.file === settings));
  changes.length = 0;
  await rename(config, `${config}-old`);
  await mkdir(config);
  await writeFile(settings, '{"defaultModel":"replacement"}');
  await waitFor(() => changes.some((change) => change.file === settings));
  changes.length = 0;
  await writeFile(settings, '{"defaultModel":"after-replacement"}');
  await waitFor(() => changes.some((change) => change.file === settings));
  assert.equal(
    changes.some((change) => change.error),
    false,
  );
  stop();
});
