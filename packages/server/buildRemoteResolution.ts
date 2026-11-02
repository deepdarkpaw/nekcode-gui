/**
 * 远端单文件 bundle 的包入口修正（esbuild `alias`）。
 *
 * 远端只部署一个 `zcode-server.cjs`，没有 node_modules，所有依赖必须在构建时静态内联。
 * jsonc-parser 的 `main` 是 UMD 包装：子模块经 `factory(require)` 间接加载，esbuild 无法跟进，
 * 会在 bundle 里留下 `require("./impl/format")` 等运行时相对导入，远端启动即 MODULE_NOT_FOUND。
 * 这里改用其 `module` 字段指向的 ESM 入口，子模块全部是静态 import，可以完整内联。
 *
 * 替换路径由 esbuild 在构建工作目录解析（hoisted node_modules）。
 */
export const remoteBundleAlias: Readonly<Record<string, string>> = {
  "jsonc-parser": "jsonc-parser/lib/esm/main.js",
};
