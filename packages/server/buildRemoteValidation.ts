export interface RemoteServerBundleValidationInput {
  bundledInputs: string[];
  source: string;
}

const unresolvedUndiciRuntimeImportPattern = /\b(?:require|import)\d*\(["']undici["']\)/;
/** 字面量相对路径的运行时 require：单文件 bundle 里出现即说明有依赖没被内联。 */
const relativeRuntimeRequirePattern = /\brequire\d*\(\s*["'](\.{1,2}\/[^"']*)["']\s*\)/g;
/** 报错时最多列出的相对 require 数量。 */
const MAX_REPORTED_RELATIVE_REQUIRES = 10;

/** 收集 bundle 中残留的相对路径 require（`.node` 原生 addon 按部署布局随包放置，除外）。 */
function findUnresolvedRelativeRequires(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(relativeRuntimeRequirePattern)) {
    const specifier = match[1];
    if (specifier.endsWith(".node")) continue;
    found.add(specifier);
    if (found.size >= MAX_REPORTED_RELATIVE_REQUIRES) break;
  }
  return [...found];
}

export function validateRemoteServerBundle({
  source,
  bundledInputs,
}: RemoteServerBundleValidationInput): void {
  // JS 和原生 addon 必须同源；拒绝再次把另一个 node-pty 版本混入远端包。
  if (bundledInputs.some((path) => /(?:^|[/\\])node-pty[/\\]lib[/\\]/.test(path))) {
    throw new Error("Remote server must use the dedicated @lydell/node-pty-linux-x64 JS runtime");
  }
  const hasUnresolvedUndiciRuntimeImport = unresolvedUndiciRuntimeImportPattern.test(source);

  if (hasUnresolvedUndiciRuntimeImport) {
    // remote deploy 只会上传单个 zcode-server.cjs 到 ~/.zcodium/server/。
    // 只有 bundle 里残留裸 undici 运行时导入才说明远端还依赖 node_modules；
    // 若当前代码已经不使用 undici，则不应把“无依赖”误判成“未内联”。
    throw new Error(
      'Remote server bundle must inline undici. Found unresolved runtime dependency "undici".',
    );
  }
  // 远端没有 bundle 旁的源文件：残留的相对 require 会在启动时 MODULE_NOT_FOUND。
  // 常见来源是 UMD 包装的间接 require，处理方式见 buildRemoteResolution.ts。
  const relativeRequires = findUnresolvedRelativeRequires(source);
  if (relativeRequires.length > 0) {
    throw new Error(
      `Remote server bundle must be self-contained. Found unresolved relative runtime require: ${relativeRequires.join(", ")}`,
    );
  }
}
