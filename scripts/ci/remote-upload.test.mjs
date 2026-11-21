import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { hasTestShell, remoteDeploymentFixture } from "./remoteDeploymentFixture.mjs";

const options = { skip: !hasTestShell, timeout: 45_000 };

for (const failure of ["corrupt", "abort"]) {
  test(
    `bundled upload ${failure} preserves an existing installation and reclaims staging`,
    options,
    async (t) => {
      const controller = new AbortController();
      let injectFailure = false;
      const fixture = await remoteDeploymentFixture(t, {
        kind: "docker",
        async afterUpload(path) {
          if (!injectFailure) return;
          if (failure === "corrupt") await writeFile(path, "corrupted transport");
          else controller.abort();
        },
      });
      await fixture.deploy();
      const live = fixture.installed("zcode-server.cjs");
      const marker = fixture.installed(".asset-components/server-bundle.json");
      const before = await Promise.all([readFile(live), readFile(marker)]);
      const commandCount = fixture.commands.length;
      injectFailure = true;
      await assert.rejects(
        fixture.deploy({ force: true, signal: controller.signal }),
        failure === "corrupt" ? /SHA256 mismatch/ : { name: "AbortError" },
      );
      assert.deepEqual(await Promise.all([readFile(live), readFile(marker)]), before);
      assert.ok(
        !fixture.commands.slice(commandCount).some((command) => command.includes("mv -fT")),
      );
      assert.ok(
        !(await readdir(fixture.installed(""))).some((name) => name.startsWith(".deploy.lock")),
      );
    },
  );
}
