import { createRequire } from "node:module";
import { join } from "node:path";

const requireFromScript = createRequire(import.meta.url);

/** 打包后必须能启动的入口：主进程由 package.json main 指定，host 与存储 worker 由 main 按固定路径拉起。 */
const REQUIRED_RUNTIME_ENTRIES = ["out/host/index.js", "out/host/tasksStorageWorker.js"];
/** tsup 产物（main/host/preload 顶层 JS 与 chunk）。 */
const BUNDLED_OUTPUT_PATTERN = /^out[\\/](main|host|preload)[\\/][^\\/]+\.js$/;
/** electron-builder 的 files 排除了 node_modules/@zcode/**，打包后的产物只能内联工作区包，不能再 import 它们。 */
const WORKSPACE_IMPORT_PATTERN = /(?:from\s*|import\(\s*)["']@zcode\//;

function toAsarPath(entry) {
  return join(...entry.split("/"));
}

function readEntry(extractFile, appAsarPath, entry) {
  let buffer;
  try {
    buffer = extractFile(appAsarPath, toAsarPath(entry));
  } catch (error) {
    throw new Error(`app.asar 缺少 ${entry}: ${error instanceof Error ? error.message : error}`);
  }
  if (!buffer || buffer.length === 0) throw new Error(`app.asar 中的 ${entry} 为空`);
  if (buffer.every((byte) => byte === 0)) throw new Error(`app.asar 中的 ${entry} 内容全为零字节`);
  return buffer;
}

function readMainEntry(extractFile, appAsarPath) {
  const text = readEntry(extractFile, appAsarPath, "package.json").toString("utf8");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new Error(`app.asar 中的 package.json 不是合法 JSON: ${error.message}`);
  }
  if (typeof manifest.main !== "string" || manifest.main.trim() === "") {
    throw new Error("app.asar 中的 package.json 缺少 main 入口");
  }
  return manifest.main.replace(/^\.\//, "");
}

function findUnbundledOutputs(extractFile, listPackage, appAsarPath) {
  return listPackage(appAsarPath, { isPack: false })
    .map((entry) => entry.replace(/^[\\/]+/, ""))
    .filter((entry) => BUNDLED_OUTPUT_PATTERN.test(entry))
    .filter((entry) =>
      WORKSPACE_IMPORT_PATTERN.test(extractFile(appAsarPath, entry).toString("utf8")),
    );
}

/**
 * 打包产物入口自检。Electron 找不到合法 package.json 时只会报「Unable to find a valid app」并以 1 退出；
 * out/ 若混入 tsc 逐文件产物（构建后再跑类型检查曾把它们写进打包目录），host 的存储准备 worker 会因
 * 找不到 @zcode/* 而启动即失败。两者都只在运行安装包时才暴露，所以生成安装包后立即校验，失败直接终止打包。
 */
export function verifyPackagedAppEntry(
  appAsarPath,
  {
    extractFile = requireFromScript("@electron/asar").extractFile,
    listPackage = requireFromScript("@electron/asar").listPackage,
  } = {},
) {
  const mainEntry = readMainEntry(extractFile, appAsarPath);
  for (const entry of [mainEntry, ...REQUIRED_RUNTIME_ENTRIES])
    readEntry(extractFile, appAsarPath, entry);
  const unbundled = findUnbundledOutputs(extractFile, listPackage, appAsarPath);
  if (unbundled.length > 0) {
    throw new Error(
      `app.asar 的 out/ 含未打包的产物（仍 import @zcode/*，多为 tsc 输出污染了打包目录），例如: ${unbundled.slice(0, 5).join(", ")}`,
    );
  }
}
