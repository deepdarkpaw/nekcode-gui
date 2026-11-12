import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import ignoreFactory from "ignore";
import type { Ignore } from "ignore";
import { ZCODE_WORKSPACE_IGNORE_FILE_NAME } from "@zcode/shared";
import type { ServiceLogger } from "../logger/serviceLogger.js";

/**
 * workspace 文件搜索忽略的单一真相源。
 *
 * `.zcodiumignore`（workspace root，gitignore 语法）是搜索索引的唯一规则文件。
 * 读写契约：
 * - 打开 / 搜索 / 列举 / 设置页读取都只读，绝不隐式创建或改写文件；
 * - 文件不存在是正常状态（不是警告、不是 fail-open 降级）：规则在内存里按
 *   root `.gitignore` 拷贝 + 内置默认段合成，内容与「保存后会落盘的初始内容」一致；
 * - 只有显式保存（writeWorkspaceFileSearchIgnore）才落盘，之后 `.gitignore` 的变化
 *   不再影响搜索，用户通过设置页编辑或「从 .gitignore 重新同步」。
 *
 * 规则解析交给 `ignore` npm 包（gitignore spec 2.22 参考实现，ESLint 同款）：
 * 后声明覆盖、`!` 反选（含父目录排除后子文件无法恢复的 git 原生约束）、anchored/basename、
 * `**` 跨层、目录后缀 `/`、字符类与转义。禁止在本仓库手写 gitignore 解析。
 */

export const WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME = ZCODE_WORKSPACE_IGNORE_FILE_NAME;
/** root `.gitignore`：`.zcodiumignore` 缺失时内存规则的来源（文件保持不变）。 */
export const WORKSPACE_FILE_GITIGNORE_FILE_NAME = ".gitignore";

type WorkspaceFileIgnoreLogger = Pick<ServiceLogger, "warn">;

/**
 * 规则来源（仅诊断用，不参与匹配）：
 * - file：`.zcodiumignore` 已存在，内容即唯一真相源；
 * - memory-gitignore / memory-template：文件缺失时的内存合成规则（缺失是正常状态，不写盘；
 *   来自 `.gitignore` 拷贝或内置默认模板）；
 * - fallback-gitignore / fallback-builtin：读取失败后的可见降级（伴随 warn 日志）。
 */
type WorkspaceFileSearchIgnoreRulesSource =
  | "file"
  | "memory-gitignore"
  | "memory-template"
  | "fallback-gitignore"
  | "fallback-builtin";

interface WorkspaceFileSearchIgnoreRules {
  matcher: Ignore;
  source: WorkspaceFileSearchIgnoreRulesSource;
}

interface WorkspaceFileSearchIgnoreContent {
  content: string;
  /**
   * file：.zcodiumignore 已存在；template：尚未创建，content 是保存后将落盘的初始内容预览。
   * 搜索/列举同样按 template 内容在内存里剪枝，但不会因此创建文件。
   */
  source: "file" | "template";
}

/**
 * 默认模板的内置排除规则：承接旧 defaultWorkspaceFileSearchFilter 目录黑名单的退役部分，
 * 保证"从零创建"的 workspace 行为与旧默认一致（node_modules/.git 等仍被剪枝）。
 * 前缀通配按 gitignore 语法表达（cmake-build-* 等），与旧 SKIPPED_DIRECTORY_PREFIXES 等价。
 */
const BUILTIN_IGNORE_LINES = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  "bower_components/",
  "jspm_packages/",
  "__pycache__/",
  "site-packages/",
  "venv/",
  "coverage/",
  "htmlcov/",
  "lcov-report/",
  "cmakefiles/",
  "cmake-build-*/",
  "bazel-*/",
  "pods/",
  "deriveddata/",
  "storybook-static/",
  "playwright-report/",
  "test-results/",
  "allure-results/",
  "allure-report/",
  "cdk.out/",
  "*.egg-info/",
  "*.dist-info/",
  "eggs/",
  "pip-wheel-metadata/",
  "wheels/",
];

const TEMPLATE_HEADER = [
  "# ZCode 工作区文件搜索忽略规则（.zcodiumignore）",
  "# 语法与 .gitignore 一致，只影响 ZCode 的 @ 文件候选 / Command Center / 文件树搜索，",
  "# 不影响文件树浏览、上传或 Agent 文件访问。",
  "# 修改 .gitignore 不会自动同步到本文件；可在设置页「从 .gitignore 同步」。",
  "",
];

/**
 * 分区标记（按行精确匹配，删除标记会让对应按钮退化为整体重建）：
 * 「从 .gitignore 同步」只重写 SYNC 标记之上的内容；
 * 「恢复默认规则」只重写两个标记之间的默认排除段；
 * DEFAULTS 标记之下的自定义规则区，任何按钮都不会改动。
 */
const WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER =
  "# ===== ↑ 以上同步自 .gitignore（「从 .gitignore 同步」只重写以上部分）=====";
const WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER =
  "# ----- ↑ 以上为 ZCode 默认排除规则（自定义规则请写在本行下方，不会被同步/恢复改动）-----";

const CUSTOM_SECTION_HINT = "# 自定义规则写在下方（本行提示可删除）";

function buildBuiltinDefaultsSection(gitignoreContent: string | null): string {
  // 创建/恢复默认时的去重：gitignore 区已声明的规则不重复写入默认段，
  // 保证文件中每条规则最多一份——用户删除一处即完全放开，不会出现
  // "删了默认段的 node_modules/ 但 gitignore 拷贝区还藏着一条"的困惑。
  // 判重保守：行 trim 后相等，或忽略单个尾 '/' 差异（node_modules 覆盖 node_modules/）；
  // anchored（/node_modules/）等写法差异不视为重复，宁可重复不可漏规则。
  if (gitignoreContent === null) {
    return BUILTIN_IGNORE_LINES.join("\n");
  }
  const declared = new Set<string>();
  for (const rawLine of gitignoreContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    declared.add(line);
    declared.add(line.replace(/\/$/, ""));
  }
  const deduped = BUILTIN_IGNORE_LINES.filter((line) => {
    const bare = line.replace(/\/$/, "");
    return !declared.has(line) && !declared.has(bare);
  });
  return deduped.join("\n");
}

/**
 * 构建 `.zcodiumignore` 初始内容：.gitignore 规则拷贝 + 双标记分区（默认排除段 / 自定义区）。
 * 附加默认段是行为兼容要求：.gitignore 未声明 node_modules 等目录的仓库若仅严格拷贝，
 * 依赖目录会被整棵放开扫描（再次出现全仓扫描的性能问题）；默认段随文件
 * 交给用户编辑，删除即放开，维持"单一真相源、无代码级并集"的承诺。
 * 默认段写入前先对 gitignore 区做规则去重（见 buildBuiltinDefaultsSection）。
 */
function buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent: string | null): string {
  const gitignoreSection =
    gitignoreContent !== null && gitignoreContent.trim().length > 0
      ? gitignoreContent.endsWith("\n")
        ? gitignoreContent
        : `${gitignoreContent}\n`
      : `${TEMPLATE_HEADER.join("\n")}\n`;
  return [
    gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    buildBuiltinDefaultsSection(gitignoreContent),
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    CUSTOM_SECTION_HINT,
    "",
  ].join("\n");
}

interface SplitWorkspaceFileSearchIgnoreSections {
  gitignoreSection: string;
  defaultsSection: string;
  customSection: string;
}

/** 按双标记切分文件；任一标记缺失（旧格式/用户删除）返回 null，调用方退化为整体重建。 */
function splitWorkspaceFileSearchIgnoreSections(
  content: string,
): SplitWorkspaceFileSearchIgnoreSections | null {
  const lines = content.split(/\r?\n/);
  const syncIndex = lines.findIndex(
    (line) => line.trim() === WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
  );
  const defaultsIndex = lines.findIndex(
    (line) => line.trim() === WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
  );
  if (syncIndex === -1 || defaultsIndex === -1 || defaultsIndex <= syncIndex) {
    return null;
  }
  return {
    gitignoreSection: lines.slice(0, syncIndex).join("\n"),
    defaultsSection: lines
      .slice(syncIndex + 1, defaultsIndex)
      .join("\n")
      .trim(),
    customSection: lines
      .slice(defaultsIndex + 1)
      .join("\n")
      .replace(/^\n+/, ""),
  };
}

/**
 * 「从 .gitignore 同步」：只重写 SYNC 标记之上的内容为当前 .gitignore，
 * 默认排除段与自定义区原样保留（用户对默认段的删改不受影响）。
 * 标记缺失时退化为整体初始内容重建（无法结构化定位分区）。
 */
function syncWorkspaceFileSearchIgnoreFromGitignore(
  currentContent: string,
  gitignoreContent: string | null,
): string {
  const sections = splitWorkspaceFileSearchIgnoreSections(currentContent);
  if (!sections) {
    return buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  }
  const gitignoreSection =
    gitignoreContent !== null && gitignoreContent.trim().length > 0
      ? gitignoreContent.endsWith("\n")
        ? gitignoreContent
        : `${gitignoreContent}\n`
      : `${TEMPLATE_HEADER.join("\n")}\n`;
  return [
    gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    sections.defaultsSection,
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    sections.customSection,
  ]
    .join("\n")
    .replace(/\n+$/, "\n");
}

/**
 * 「恢复默认规则」：只重置默认排除段为内置清单，gitignore 区与自定义区原样保留。
 * 标记缺失时退化为整体初始内容重建。
 */
function resetWorkspaceFileSearchIgnoreDefaults(
  currentContent: string,
  gitignoreContent: string | null,
): string {
  const sections = splitWorkspaceFileSearchIgnoreSections(currentContent);
  if (!sections) {
    return buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  }
  // 恢复默认按当前 gitignore 区规则去重重算：gitignore 已声明的行不重复写回默认段；
  // 若用户曾从 .gitignore 删掉 node_modules 等，恢复时默认段会把它补回（兜底回归）。
  return [
    sections.gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    buildBuiltinDefaultsSection(sections.gitignoreSection),
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    sections.customSection,
  ]
    .join("\n")
    .replace(/\n+$/, "\n");
}

// ignore 包的 index.d.ts 在 nodenext 下把 default import 解析为模块命名空间（无调用签名），
// 而运行时 default 恰是工厂函数本身（Node ESM interop 实测）。这里显式收窄回工厂签名。
const createIgnoreMatcher: () => Ignore = ignoreFactory as unknown as () => Ignore;

function buildIgnoreMatcher(content: string): Ignore {
  return createIgnoreMatcher().add(content);
}

function isNotFoundError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * 原子写：目标目录内写临时文件（flush + close）后 rename 替换，参照
 * workspace-hook-mutation.ts 的模式，保证 Runtime/设置页不会观察到半截规则文件。
 */
async function atomicWriteIgnoreFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const tempPath = resolve(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o644);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 读取失败时的可见降级链：`.gitignore` 内容 → 内置默认规则。
 * 只有「.zcodiumignore 读取失败」才走这里；文件不存在不算降级（见 load 主流程）。
 */
async function loadFallbackIgnoreRules(
  rootPath: string,
  logger: WorkspaceFileIgnoreLogger | undefined,
  reason: string,
  error: unknown,
): Promise<WorkspaceFileSearchIgnoreRules> {
  let gitignoreContent: string | null;
  try {
    gitignoreContent = await readOptionalFile(
      resolve(rootPath, WORKSPACE_FILE_GITIGNORE_FILE_NAME),
    );
  } catch (gitignoreError) {
    logger?.warn(
      undefined,
      `[workspace-file-ignore] ${reason}，且读取 ${WORKSPACE_FILE_GITIGNORE_FILE_NAME} 失败，降级为内置默认忽略规则`,
      gitignoreError,
    );
    return {
      matcher: buildIgnoreMatcher(buildWorkspaceFileSearchIgnoreTemplate(null)),
      source: "fallback-builtin",
    };
  }
  if (gitignoreContent !== null) {
    logger?.warn(
      undefined,
      `[workspace-file-ignore] ${reason}，降级为运行时使用 ${WORKSPACE_FILE_GITIGNORE_FILE_NAME} 规则`,
      error,
    );
    return {
      matcher: buildIgnoreMatcher(gitignoreContent),
      source: "fallback-gitignore",
    };
  }
  logger?.warn(undefined, `[workspace-file-ignore] ${reason}，降级为内置默认忽略规则`, error);
  return {
    matcher: buildIgnoreMatcher(buildWorkspaceFileSearchIgnoreTemplate(null)),
    source: "fallback-builtin",
  };
}

/**
 * 扫描前加载 `.zcodiumignore` 规则。只读，绝不隐式写盘：
 * - 文件存在 → 内容原样生效（唯一权威规则源）；
 * - 文件缺失（正常状态）→ 内存合成「保存后才会落盘的初始内容」：
 *   `.gitignore` 拷贝 + 内置默认段；不创建、不改名、不做自动迁移；
 * - 读取失败（只读 fs、权限）→ 可见 warn 后按 .gitignore → 内置默认规则降级。
 * 写盘只发生在设置页显式保存（writeWorkspaceFileSearchIgnore）。
 */
export async function loadWorkspaceFileSearchIgnoreRules(
  rootPath: string,
  logger?: WorkspaceFileIgnoreLogger,
): Promise<WorkspaceFileSearchIgnoreRules> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);

  let existing: string | null;
  try {
    existing = await readOptionalFile(ignorePath);
  } catch (error) {
    return loadFallbackIgnoreRules(
      rootPath,
      logger,
      `读取 ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME} 失败`,
      error,
    );
  }
  if (existing !== null) {
    return { matcher: buildIgnoreMatcher(existing), source: "file" };
  }

  // 缺失路径同样只读：合成规则进内存，磁盘上不会出现新文件。
  let gitignoreContent: string | null;
  try {
    gitignoreContent = await readOptionalFile(
      resolve(rootPath, WORKSPACE_FILE_GITIGNORE_FILE_NAME),
    );
  } catch (error) {
    // `.gitignore` 不可读不是「文件缺失」：保留可见的降级来源，不要静默当成无规则。
    logger?.warn(
      undefined,
      `[workspace-file-ignore] 读取 ${WORKSPACE_FILE_GITIGNORE_FILE_NAME} 失败，降级为内置默认忽略规则`,
      error,
    );
    return {
      matcher: buildIgnoreMatcher(buildWorkspaceFileSearchIgnoreTemplate(null)),
      source: "fallback-builtin",
    };
  }
  return {
    matcher: buildIgnoreMatcher(buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent)),
    source: gitignoreContent !== null ? "memory-gitignore" : "memory-template",
  };
}

/**
 * 判定相对路径是否被忽略。目录必须传带尾斜杠的路径（gitignore dirOnly 规则只匹配目录），
 * relativePath 由调用方保证为 posix 分隔符（fileService 的 normalizeRelativePath 已转换）。
 */
export function isWorkspaceFileSearchPathIgnored(
  rules: WorkspaceFileSearchIgnoreRules,
  relativePath: string,
  type: "file" | "directory",
): boolean {
  return type === "directory"
    ? rules.matcher.ignores(`${relativePath}/`)
    : rules.matcher.ignores(relativePath);
}

/** 设置页读取：文件不存在时返回初始内容预览（source: template），不落盘、不创建文件。 */
export async function readWorkspaceFileSearchIgnore(
  rootPath: string,
): Promise<WorkspaceFileSearchIgnoreContent> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  const existing = await readOptionalFile(ignorePath);
  if (existing !== null) {
    return { content: existing, source: "file" };
  }
  const gitignoreContent = await readOptionalFile(
    resolve(rootPath, WORKSPACE_FILE_GITIGNORE_FILE_NAME),
  ).catch(() => null);
  return {
    content: buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent),
    source: "template",
  };
}

type WorkspaceFileSearchIgnoreTransform = "sync-gitignore" | "reset-defaults";

/**
 * 设置页分区操作（返回新内容填充编辑框，保存才落盘）：
 * sync-gitignore 只重写 gitignore 同步区；reset-defaults 只重置默认排除段；
 * 两者都保留标记之外的用户内容，详见各纯函数的契约。
 */
export async function transformWorkspaceFileSearchIgnore(
  rootPath: string,
  transform: WorkspaceFileSearchIgnoreTransform,
): Promise<{ content: string }> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  const existing = await readOptionalFile(ignorePath).catch(() => null);
  const gitignoreContent = await readOptionalFile(
    resolve(rootPath, WORKSPACE_FILE_GITIGNORE_FILE_NAME),
  ).catch(() => null);
  const currentContent = existing ?? buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  const content =
    transform === "sync-gitignore"
      ? syncWorkspaceFileSearchIgnoreFromGitignore(currentContent, gitignoreContent)
      : resetWorkspaceFileSearchIgnoreDefaults(currentContent, gitignoreContent);
  return { content };
}

/**
 * 设置页保存：唯一允许创建/改写 `.zcodiumignore` 的入口（原子写整个文件），
 * 下次扫描读取即为新内容。
 */
export async function writeWorkspaceFileSearchIgnore(
  rootPath: string,
  content: string,
): Promise<void> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  await atomicWriteIgnoreFile(ignorePath, content);
}
