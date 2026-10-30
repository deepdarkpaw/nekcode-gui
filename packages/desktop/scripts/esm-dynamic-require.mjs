/**
 * 扫描 desktop 的 ESM 产物（out/main、out/host），找出 esbuild「动态 require」shim 的调用点。
 *
 * CommonJS 依赖被内联进 ESM bundle 后，它对 Node 内置模块的 `require("path")` 会改写成
 * shim 调用；Electron 以 ESM 加载 main/host 时没有 `require`，shim 直接抛
 * `Dynamic require of "path" is not supported`，应用启动即崩溃。这类依赖必须列入
 * `tsup.config.ts` 的 `desktopNodeRuntimeExternals`。
 *
 * shim 只在一个公共 chunk 里定义，其余 chunk 以别名 import，所以要沿 export/import 解析本地名。
 * `bundle.mjs` 在 electron-builder 之前调用；也可单独运行：
 * `node packages/desktop/scripts/esm-dynamic-require.mjs packages/desktop/out`。
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SHIM_DEFINITION =
  /([\w$]+)=\(\s*[\w$]+\s*=>\s*typeof require\s*<\s*"u"\s*\?\s*require\s*:[\s\S]{0,400}?Dynamic require of/;
const EXPORT_CLAUSE = /export\s*\{([^}]*)\}/g;
const CHUNK_IMPORT = /import\s*\{([^}]*)\}\s*from\s*"\.\/([^"]+\.js)"/g;

function escapeIdentifier(name) {
  return name.replace(/\$/g, "\\$");
}

/** `a as b, c` → [[a, b], [c, c]] */
function parseSpecifiers(clause) {
  return clause
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const [from, to] = part.split(/\s+as\s+/);
      return [from.trim(), (to ?? from).trim()];
    });
}

/** 定义 shim 的 chunk → 它导出的 shim 名。 */
function findShimExports(sources) {
  const exports = new Map();
  for (const { name, text } of sources) {
    const local = SHIM_DEFINITION.exec(text)?.[1];
    if (!local) continue;
    for (const match of text.matchAll(EXPORT_CLAUSE)) {
      for (const [from, to] of parseSpecifiers(match[1])) {
        if (from === local) exports.set(name, to);
      }
    }
  }
  return exports;
}

/** 某个文件里指向 shim 的全部本地名（自身定义 + 从定义 chunk 导入的别名）。 */
function shimLocals(name, text, shimExports) {
  const locals = new Set();
  const own = SHIM_DEFINITION.exec(text)?.[1];
  if (own) locals.add(own);
  for (const match of text.matchAll(CHUNK_IMPORT)) {
    const exported = shimExports.get(match[2]);
    if (!exported || match[2] === name) continue;
    for (const [from, to] of parseSpecifiers(match[1])) {
      if (from === exported) locals.add(to);
    }
  }
  return locals;
}

async function readTarget(dir) {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".js"));
  return await Promise.all(
    files.map(async (name) => ({ name, text: await readFile(join(dir, name), "utf8") })),
  );
}

/** 返回 `{ file, specifier }[]`：每个会在运行时触发 shim 的 require 调用。 */
export async function findDynamicRequireCalls(outDir) {
  const findings = [];
  for (const target of ["main", "host"]) {
    const dir = join(outDir, target);
    const sources = await readTarget(dir);
    const shimExports = findShimExports(sources);
    for (const { name, text } of sources) {
      for (const local of shimLocals(name, text, shimExports)) {
        const call = new RegExp(`(?<![\\w$.])${escapeIdentifier(local)}\\("([^"]+)"\\)`, "g");
        for (const match of text.matchAll(call)) {
          findings.push({ file: relative(outDir, join(dir, name)), specifier: match[1] });
        }
      }
    }
  }
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outDir = process.argv[2] ?? "packages/desktop/out";
  const findings = await findDynamicRequireCalls(outDir);
  for (const { file, specifier } of findings) console.log(`${file}: require("${specifier}")`);
  console.log(`dynamic require calls: ${findings.length}`);
  process.exitCode = findings.length > 0 ? 1 : 0;
}
