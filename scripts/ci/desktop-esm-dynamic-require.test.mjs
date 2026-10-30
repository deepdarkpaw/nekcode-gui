import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findDynamicRequireCalls } from "../../packages/desktop/scripts/esm-dynamic-require.mjs";

/** esbuild 生成的 shim（与真实压缩产物同形）。 */
const SHIM =
  'var ye=(t=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(t,{get:(e,n)=>(typeof require<"u"?require:e)[n]}):t)(function(t){if(typeof require<"u")return require.apply(this,arguments);throw Error(\'Dynamic require of "\'+t+\'" is not supported\')});';

async function withOutDir(files, run) {
  const root = await mkdtemp(join(tmpdir(), "esm-dynamic-require-"));
  try {
    for (const target of ["main", "host"]) await mkdir(join(root, target));
    for (const [path, text] of Object.entries(files)) await writeFile(join(root, path), text);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("finds shim calls through aliased chunk imports", async () => {
  const findings = await withOutDir(
    {
      "main/chunk-A.js": `${SHIM}var a=ye("os");export{ye as a};`,
      "main/chunk-B.js": 'import{a as Ne}from"./chunk-A.js";var x=Ne("path"),y=obj.Ne("fs");',
      "main/index.js": 'import{a}from"./chunk-A.js";a("events");',
      "host/index.js": "export const ok=1;",
    },
    findDynamicRequireCalls,
  );
  const calls = findings.map(({ file, specifier }) => `${file.replace(/\\/g, "/")}:${specifier}`);
  assert.deepEqual(calls.sort(), [
    "main/chunk-A.js:os",
    "main/chunk-B.js:path",
    "main/index.js:events",
  ]);
});

test("reports nothing when CommonJS dependencies stay external", async () => {
  const findings = await withOutDir(
    {
      "main/index.js": 'import lockfile from"proper-lockfile";lockfile.lockSync("x");',
      "host/index.js": 'import{Client}from"ssh2";new Client;',
    },
    findDynamicRequireCalls,
  );
  assert.deepEqual(findings, []);
});
