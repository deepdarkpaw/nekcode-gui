/**
 * 守卫：`@zcode/services` 的浏览器入口（src/index.ts，renderer 直接 import）沿值导入
 * 可达的模块里，不允许出现 Node 专用依赖。
 *
 * Vite 打 renderer 时会把 CommonJS 的 Node 包照常内联、构建不报错，直到运行期才抛
 * `process is not defined`（graceful-fs 的 polyfill），React 永远挂不上。曾因入口误导出
 * `NekAgentServiceAdapter`（nek 进程 + proper-lockfile 配置锁）导致打包应用白屏。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ENTRY = join(ROOT, "packages/services/src/index.ts");

/** 只能在 Node / Electron 主进程运行的第三方包。 */
const NODE_ONLY_PACKAGES = new Set([
  "graceful-fs",
  "node-forge",
  "node-pty",
  "proper-lockfile",
  "ssh-config",
  "ssh2",
  "undici",
  "yauzl",
  "yazl",
]);

const IMPORT_STATEMENT =
  /^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*["']([^"']+)["'];?|^\s*import\s+["']([^"']+)["'];?/gm;

/** `import { type A, type B }` 这类全是类型的子句会被 TS 擦除。 */
function isTypeOnlyClause(clause) {
  const braces = /^\{([\s\S]*)\}$/.exec(clause.trim());
  if (!braces) return false;
  const names = braces[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((name) => name.startsWith("type "));
}

function valueSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(IMPORT_STATEMENT)) {
    if (match[5]) {
      specifiers.push(match[5]);
      continue;
    }
    if (match[2] || isTypeOnlyClause(match[3])) continue;
    specifiers.push(match[4]);
  }
  return specifiers;
}

function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ""));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${relative(ROOT, fromFile)}`);
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** 从入口出发收集 `{ specifier, file }`：所有可达的非相对值导入。 */
function collectReachableImports(entry) {
  const visited = new Set();
  const external = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of valueSpecifiers(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        queue.push(resolveRelative(file, specifier));
        continue;
      }
      external.push({ specifier, file: relative(ROOT, file).replaceAll("\\", "/") });
    }
  }
  return { files: visited.size, external };
}

test("@zcode/services browser entry reaches no Node-only dependency", () => {
  const { files, external } = collectReachableImports(ENTRY);
  assert.ok(files > 1, "import graph walk found no modules; check the entry path");
  const violations = external
    .filter(({ specifier }) => {
      if (specifier.startsWith("node:") || isBuiltin(specifier)) return true;
      return NODE_ONLY_PACKAGES.has(packageName(specifier));
    })
    .map(({ specifier, file }) => `${file} → ${specifier}`);
  assert.deepEqual(
    violations,
    [],
    `browser entry pulls Node-only modules:\n${violations.join("\n")}`,
  );
});
