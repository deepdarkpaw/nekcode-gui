import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildServer } from "../../packages/server/build.mjs";

function recordBuild(env, failAt) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (calls.length === failAt) throw new Error("build failed");
  };
  return { calls, execute: () => buildServer({ env, run }) };
}

test("server build produces the remote bundle by default", () => {
  for (const flag of [undefined, "", "0", "true"]) {
    const env = { ZCODE_SKIP_REMOTE_ASSETS: flag };
    const build = recordBuild(env);
    build.execute();
    assert.deepEqual(
      build.calls.map(({ args }) => args),
      [["run", "build:remote"]],
    );
    assert.ok(build.calls.every((call) => call.env === env));
  }
});

test("explicit remote asset opt-out skips duplicating the artifact producer", () => {
  const build = recordBuild({ ZCODE_SKIP_REMOTE_ASSETS: "1" });
  build.execute();
  assert.deepEqual(build.calls, []);
});

test("remote build failures propagate", () => {
  const build = recordBuild({}, 1);
  assert.throws(build.execute, /build failed/);
  assert.equal(build.calls.length, 1);
});

test("package build uses the tested owner and direct remote entry never honors opt-out", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../../packages/server/package.json", import.meta.url)),
  );
  assert.equal(pkg.scripts.build, "node build.mjs");
  assert.equal(pkg.scripts["build:remote"], "tsx build-remote.ts");
});
