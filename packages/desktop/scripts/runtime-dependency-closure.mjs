import { existsSync, readFileSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { createRequire } from "node:module";

function findPackageRoot(entryPath) {
  let currentDir = dirname(entryPath);
  const root = parse(currentDir).root;
  while (currentDir !== root) {
    const packageJsonPath = resolve(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      return currentDir;
    }
    currentDir = dirname(currentDir);
  }
  return null;
}

function readRuntimePackage(moduleLookupRoots, moduleName, parentPackagePath = null) {
  if (parentPackagePath) {
    try {
      const requireFromParent = createRequire(parentPackagePath);
      const entryPath = requireFromParent.resolve(moduleName);
      const packageRoot = findPackageRoot(entryPath);
      if (packageRoot) {
        const packageJsonPath = resolve(packageRoot, "package.json");
        return {
          packageJson: JSON.parse(readFileSync(packageJsonPath, "utf8")),
          packageJsonPath,
          packageRoot,
        };
      }
    } catch {
      // 父包相对解析失败时，继续走 workspace lookup roots 兜底。
    }
  }

  for (const lookupRoot of moduleLookupRoots) {
    const packageJsonPath = resolve(lookupRoot, "node_modules", moduleName, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    return {
      packageJson: JSON.parse(readFileSync(packageJsonPath, "utf8")),
      packageJsonPath,
      packageRoot: dirname(packageJsonPath),
    };
  }
  return null;
}

/**
 * 包在运行时 node_modules 树中的安装路径（相对最外层 node_modules）。
 * 父包依赖的版本与 hoisted 同名包不同时，包管理器会把它装在 `<parent>/node_modules/<name>`；
 * 注入与校验必须沿用这个嵌套位置，否则运行时会解析到 hoisted 的另一个版本
 * （proper-lockfile 需要 signal-exit@3，平铺后拿到 hoisted 的 v4，启动即 `onExit is not a function`）。
 */
export function resolveInstallPath(packageRoot, moduleName) {
  const normalized = packageRoot.replaceAll("\\", "/");
  const marker = "/node_modules/";
  const first = normalized.indexOf(marker);
  if (first < 0) return moduleName;
  const relativePath = normalized.slice(first + marker.length);
  // pnpm 虚拟存储（.pnpm/...）不是运行时布局，按包名平铺。
  return relativePath.startsWith(".pnpm/") ? moduleName : relativePath;
}

export function collectRuntimeModuleClosure(moduleNames, moduleLookupRoots) {
  return collectRuntimeModuleClosureEntries(moduleNames, moduleLookupRoots).map(
    (entry) => entry.moduleName,
  );
}

export function collectRuntimeModuleClosureEntries(moduleNames, moduleLookupRoots) {
  const collected = [];
  const visited = new Set();

  function visit(moduleName, optional = false, parentPackagePath = null) {
    const runtimePackage = readRuntimePackage(moduleLookupRoots, moduleName, parentPackagePath);
    if (!runtimePackage && optional) {
      return;
    }

    // 按安装路径去重：同名包的不同版本（hoisted 与嵌套）都要各自进入闭包。
    const installPath = runtimePackage
      ? resolveInstallPath(runtimePackage.packageRoot, moduleName)
      : moduleName;
    if (visited.has(installPath)) {
      return;
    }

    visited.add(installPath);
    collected.push({
      moduleName,
      installPath,
      sourceModulePath: runtimePackage?.packageRoot ?? null,
      packageJsonPath: runtimePackage?.packageJsonPath ?? null,
    });

    if (!runtimePackage) {
      return;
    }

    const { packageJson, packageJsonPath } = runtimePackage;
    const dependencies = packageJson.dependencies ?? {};
    const optionalDependencies = packageJson.optionalDependencies ?? {};
    const dependencyEntries = [
      ...Object.keys(dependencies).map((dependencyName) => [dependencyName, false]),
      ...Object.keys(optionalDependencies).map((dependencyName) => [dependencyName, true]),
    ];

    for (const [dependencyName, isOptional] of dependencyEntries.sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      // 运行时外置包进了 app.asar 时，它的 hoisted 子依赖不会自动跟着进包。
      // 递归收集 dependencies，让打包注入和产物校验覆盖完整运行时解析链。
      // pnpm 多版本同名依赖下，不能每层都从固定 lookup roots 取第一个目录。
      // 例如 yazl 需要 buffer-crc32@1.x，而 desktop 测试依赖里还有 0.2.x；
      // 必须从父包 package.json 相对解析，才能复制到真实运行时会加载的版本。
      visit(dependencyName, isOptional, packageJsonPath);
    }
  }

  for (const moduleName of moduleNames) {
    visit(moduleName);
  }

  return collected;
}
