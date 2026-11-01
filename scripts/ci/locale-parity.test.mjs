import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

function keysOf(source) {
  // Locale keys have two-space indentation; wrapped translation lines are not keys.
  return new Set(
    [...source.matchAll(/^ {2}"([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)":/gm)].map((m) => m[1]),
  );
}

test("locale zh-CN 与 en-US 键集一致", async () => {
  const zh = keysOf(
    await readFile(new URL("../../packages/ui/src/i18n/locales/zh-CN.ts", import.meta.url), "utf8"),
  );
  const en = keysOf(
    await readFile(new URL("../../packages/ui/src/i18n/locales/en-US.ts", import.meta.url), "utf8"),
  );
  const zhOnly = [...zh].filter((k) => !en.has(k));
  const enOnly = [...en].filter((k) => !zh.has(k));
  assert.deepEqual(zhOnly, [], `zh-CN 独有的键：${zhOnly.join(", ")}`);
  assert.deepEqual(enOnly, [], `en-US 独有的键：${enOnly.join(", ")}`);
});
