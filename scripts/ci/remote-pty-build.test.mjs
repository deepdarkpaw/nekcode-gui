import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { tsImport } from "tsx/esm/api";
import { createRemotePtyBuildPlugin } from "../remote-pty-build.mjs";
const { validateRemoteServerBundle } = await tsImport(
  "../../packages/server/buildRemoteValidation.ts",
  import.meta.url,
);
const { remoteBundleAlias } = await tsImport(
  "../../packages/server/buildRemoteResolution.ts",
  import.meta.url,
);

/** 用远端 bundle 的格式打包 jsonc-parser；alias 为空时走 esbuild 默认（UMD main）。 */
async function bundleJsoncParser(alias) {
  const result = await build({
    stdin: {
      contents: 'export { applyEdits, modify, parse } from "jsonc-parser";',
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "cjs",
    ...(alias ? { alias: { ...alias } } : {}),
  });
  return { bundledInputs: Object.keys(result.metafile.inputs), source: result.outputFiles[0].text };
}

test("remote build inlines the JS wrapper matching the dedicated native PTY package", async () => {
  const result = await build({
    stdin: { contents: 'export { spawn } from "node-pty";', resolveDir: process.cwd() },
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "cjs",
    plugins: [createRemotePtyBuildPlugin()],
  });
  const bundledInputs = Object.keys(result.metafile.inputs);
  assert.ok(
    bundledInputs.some((path) => path.includes("@lydell/node-pty-linux-x64/lib/unixTerminal.js")),
  );
  validateRemoteServerBundle({ bundledInputs, source: result.outputFiles[0].text });
});

test("remote validation rejects a mixed node-pty wrapper and unresolved runtime imports", () => {
  assert.throws(
    () =>
      validateRemoteServerBundle({
        bundledInputs: ["node_modules/node-pty/lib/unixTerminal.js"],
        source: "",
      }),
    /dedicated/,
  );
  assert.throws(
    () => validateRemoteServerBundle({ bundledInputs: [], source: 'require("undici")' }),
    /inline undici/,
  );
});

test("remote validation rejects relative runtime requires but allows native addons", () => {
  assert.throws(
    () => validateRemoteServerBundle({ bundledInputs: [], source: 'require4("./impl/format")' }),
    /self-contained.*\.\/impl\/format/,
  );
  validateRemoteServerBundle({
    bundledInputs: [],
    source: 'require("./build/Release/pty.node")',
  });
});

test("remote alias inlines jsonc-parser's ESM build so the single-file bundle runs", async (t) => {
  const aliased = await bundleJsoncParser(remoteBundleAlias);
  assert.ok(
    aliased.bundledInputs.some((path) => path.endsWith("jsonc-parser/lib/esm/impl/format.js")),
  );
  validateRemoteServerBundle(aliased);

  // 远端只有这一个文件：在空目录里单独加载并实际调用，证明不依赖任何相邻模块。
  const directory = await mkdtemp(join(tmpdir(), "remote-jsonc-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "bundle.cjs");
  await writeFile(file, aliased.source);
  const jsonc = createRequire(import.meta.url)(file);
  const text = '{\n  // keep\n  "a": 1\n}';
  assert.equal(
    jsonc.applyEdits(text, jsonc.modify(text, ["a"], 2, {})),
    '{\n  // keep\n  "a": 2\n}',
  );

  // 反向：不加 alias 时 esbuild 走 UMD main，残留的相对 require 必须被校验拦下。
  const umd = await bundleJsoncParser(undefined);
  assert.throws(() => validateRemoteServerBundle(umd), /\.\/impl\/format/);
});
