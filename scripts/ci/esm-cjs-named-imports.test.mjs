/**
 * 守卫：Node 侧源码对第三方包的具名值导入，必须在真实 Node ESM 下可用。
 *
 * CommonJS 包的具名导出靠 cjs-module-lexer 静态检测；`module.exports = { utils: { ... } }`
 * 这类写法检测不到，tsx / vitest 的互操作层会掩盖问题，打包后以原生 ESM 加载才抛
 * `SyntaxError: does not provide an export named ...`（ssh2 的 `utils` 曾因此让应用启动即崩溃）。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 打包后由 Node 以 ESM 直接加载的源码目录。 */
const SCAN_ROOTS = [
  "packages/server/src",
  "packages/services/src",
  "packages/shared/src",
  "packages/desktop/src/main",
  "packages/desktop/src/host",
];

/** 只能在 Electron 进程内求值的包。 */
const ELECTRON_ONLY = new Set(["electron"]);

const NAMED_IMPORT = /^import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*"([^"]+)";/gm;

async function listSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return await listSourceFiles(path);
      if (!/\.(?:ts|mts|mjs)$/.test(entry.name)) return [];
      if (/\.(?:test|spec)\.|\.d\.ts$/.test(entry.name)) return [];
      return [path];
    }),
  );
  return nested.flat();
}

function isThirdParty(specifier) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#")) {
    return false;
  }
  if (specifier.startsWith("node:") || isBuiltin(specifier)) return false;
  if (specifier.startsWith("@zcode/") || specifier.startsWith("@/")) return false;
  return !ELECTRON_ONLY.has(specifier);
}

function valueBindings(clause) {
  return clause
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith("type "))
    .map((part) => part.split(/\s+as\s+/)[0].trim());
}

/** 收集 specifier → [{ name, file }]。 */
async function collectNamedImports() {
  const bySpecifier = new Map();
  for (const root of SCAN_ROOTS) {
    for (const file of await listSourceFiles(join(ROOT, root))) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(NAMED_IMPORT)) {
        const specifier = match[2];
        if (!isThirdParty(specifier)) continue;
        const uses = bySpecifier.get(specifier) ?? [];
        for (const name of valueBindings(match[1])) {
          uses.push({ name, file: relative(ROOT, file) });
        }
        if (uses.length > 0) bySpecifier.set(specifier, uses);
      }
    }
  }
  return bySpecifier;
}

test("third-party named value imports resolve under native Node ESM", async (t) => {
  const bySpecifier = await collectNamedImports();
  assert.ok(bySpecifier.size > 0, "scan found no third-party named imports; check SCAN_ROOTS");
  const missing = [];
  for (const [specifier, uses] of bySpecifier) {
    let namespace;
    try {
      namespace = await import(specifier);
    } catch (error) {
      t.diagnostic(
        `skip ${specifier}: cannot be evaluated outside its runtime (${error.code ?? error.message})`,
      );
      continue;
    }
    for (const { name, file } of uses) {
      if (!(name in namespace)) missing.push(`${file}: { ${name} } from "${specifier}"`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `named imports unavailable under native ESM:\n${missing.join("\n")}`,
  );
});
