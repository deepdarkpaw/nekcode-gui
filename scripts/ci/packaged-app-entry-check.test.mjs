import assert from "node:assert/strict";
import { join, sep } from "node:path";
import test from "node:test";
import { verifyPackagedAppEntry } from "../../packages/desktop/scripts/packaged-app-entry-check.mjs";

const healthy = {
  "package.json": Buffer.from(
    JSON.stringify({ name: "@zcode/desktop", main: "out/main/index.js" }),
  ),
  "out/main/index.js": Buffer.from("import './chunk.js';"),
  "out/host/index.js": Buffer.from("import './chunk.js';"),
  "out/host/tasksStorageWorker.js": Buffer.from("import './chunk.js';"),
};

/** 与 @electron/asar 一致：extractFile 收平台分隔符路径，listPackage 返回带前导分隔符的平台路径。 */
function fakeAsar(files) {
  const byNativePath = new Map(
    Object.entries(files).map(([path, data]) => [join(...path.split("/")), data]),
  );
  return {
    extractFile: (_archive, path) => {
      if (!byNativePath.has(path)) throw new Error(`"${path}" was not found in this archive`);
      return byNativePath.get(path);
    },
    listPackage: () => [...byNativePath.keys()].map((path) => `${sep}${path}`),
  };
}

test("a packaged app with a valid manifest and bundled entries passes", () => {
  verifyPackagedAppEntry("app.asar", fakeAsar(healthy));
});

test("a zero-filled package.json fails instead of shipping an app Electron cannot start", () => {
  const files = { ...healthy, "package.json": Buffer.alloc(1210) };
  assert.throws(
    () => verifyPackagedAppEntry("app.asar", fakeAsar(files)),
    /package\.json 内容全为零字节/,
  );
});

test("an unparsable manifest or a missing main entry fails", () => {
  assert.throws(
    () =>
      verifyPackagedAppEntry(
        "app.asar",
        fakeAsar({ ...healthy, "package.json": Buffer.from("{") }),
      ),
    /不是合法 JSON/,
  );
  const { "out/main/index.js": _main, ...withoutMain } = healthy;
  assert.throws(
    () => verifyPackagedAppEntry("app.asar", fakeAsar(withoutMain)),
    /缺少 out\/main\/index\.js/,
  );
});

test("the host storage worker must be packaged", () => {
  const { "out/host/tasksStorageWorker.js": _worker, ...files } = healthy;
  assert.throws(
    () => verifyPackagedAppEntry("app.asar", fakeAsar(files)),
    /tasksStorageWorker\.js/,
  );
});

test("unbundled output that still imports workspace packages fails the bundle", () => {
  const files = {
    ...healthy,
    "out/host/hostDatabaseStartup.js": Buffer.from('import { logger } from "@zcode/shared";'),
  };
  assert.throws(() => verifyPackagedAppEntry("app.asar", fakeAsar(files)), /未打包的产物/);
  const lazy = {
    ...healthy,
    "out/main/lazy.js": Buffer.from('await import("@zcode/services/node");'),
  };
  assert.throws(
    () => verifyPackagedAppEntry("app.asar", fakeAsar(lazy)),
    /out[\\/]main[\\/]lazy\.js/,
  );
});
