// `packages/shared/src/diagnosticLogCatalog.ts` 由 `scripts/diagnostic-log-catalog.mjs` 从源码扫描生成。
// 它是诊断日志的词表白名单：源码新增日志文案而目录没同步时，线上那条日志会被静默丢弃。
// 因此这里重跑生成器，把结果与已提交的目录做语义比对（格式交给 oxfmt 门禁）。
//
// 生成器只会就地写这一个文件，且 CI 用 `--test-isolation=none` 串行执行；
// 为了让本地并行跑也不留痕迹，不论成败都用 tmp + rename 把内容原子恢复。
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const generator = fileURLToPath(new URL("../diagnostic-log-catalog.mjs", import.meta.url));
const catalog = fileURLToPath(
  new URL("../../packages/shared/src/diagnosticLogCatalog.ts", import.meta.url),
);
const restoreStaging = `${catalog}.freshness-restore`;

/** 取出 `export const <name>: readonly string[] = [...]` 的数组（去掉 oxfmt 加的尾逗号）。 */
function vocabulary(source, name) {
  const match = source.match(
    new RegExp(`export const ${name}: readonly string\\[\\] = (\\[[\\s\\S]*?\\n\\]);`),
  );
  assert.ok(match, `diagnosticLogCatalog.ts 缺少 ${name} 导出`);
  return JSON.parse(match[1].replaceAll(/,(?=\s*\])/g, ""));
}

test("the diagnostic log catalog matches the current sources", async () => {
  const committed = await readFile(catalog, "utf8");
  let generated;
  try {
    const run = spawnSync(process.execPath, [generator], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(run.status, 0, `生成器失败：${run.stderr || run.stdout}`);
    generated = await readFile(catalog, "utf8");
  } finally {
    await writeFile(restoreStaging, committed);
    await rename(restoreStaging, catalog);
    await rm(restoreStaging, { force: true });
  }
  for (const name of ["diagnosticMessages", "diagnosticPrefixes", "diagnosticModules"]) {
    assert.deepEqual(
      vocabulary(generated, name),
      vocabulary(committed, name),
      `${name} 已漂移：运行 node scripts/diagnostic-log-catalog.mjs 并提交结果`,
    );
  }
});
