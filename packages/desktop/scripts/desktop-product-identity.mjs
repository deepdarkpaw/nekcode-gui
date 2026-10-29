/**
 * 构建期开关：为真时安装包使用 Preview 身份，而后端环境仍由 `ZCODE_ENV` 单独决定。
 * 典型用法是 `ZCODE_ENV=production ZCODE_PREVIEW_IDENTITY=1`，得到一个连接生产后端的
 * `nekcode-preview`，可与正式版并排安装。
 *
 * 2026-10 品牌改名：产品身份从 `ZCodium Exp` / `ZCodium Rust` 改为 `nekcode` /
 * `nekcode-preview`，appId 一并换成 `ai.nekcode.desktop`（正式）与
 * `ai.nekcode.desktop.preview`（预览）。两个身份保持独立 appId，`nekcode` 与
 * `nekcode-preview` 才能并排安装，并各自拥有独立的 Electron userData 目录与
 * `~/Library/Caches/<appId>-updater` 更新缓存。
 *
 * preview 仍是滚动更新模型下的提前通道（见 .agents/specs/rolling-update.md 渠道决策），
 * 需要独立的产品名与用户沟通。
 *
 * `productName` 不带点也不带空格：它会流进 macOS `.app` 名（`${productName}.app`）、
 * Electron userData 目录名与安装包文件名，带点会得到 `nekcode..app`，Windows 目录名
 * 也不能以点结尾。展示形态放 i18n / About / 文档等纯展示层。
 */
/**
 * 深链 / OAuth 回调共用的协议 scheme。
 *
 * 唯一来源：electron-builder `protocols` 注册（打包期）与主进程 `desktopDeepLinkUrl.ts`、
 * `desktopOAuthDeepLink.ts`、Linux 桌面条目（运行期）都从这里取，避免出现
 * 「安装包注册 A、主进程解析 B」的静默失配。
 */
export const NEKCODE_DEEP_LINK_SCHEME = "nekcode";

/** GitHub Releases 更新源的默认 owner / repo，可用构建期环境变量覆盖。 */
const DEFAULT_GITHUB_PUBLISH_OWNER = "nekcode";
const DEFAULT_GITHUB_PUBLISH_REPO = "nekcode-gui";

/**
 * 解析发布/更新仓库的 owner 与 repo：环境变量优先，空值视为未设置。
 *
 * 允许覆盖是为了在 fork 或镜像仓库上出包时，安装包的 app-update.yml 指向真实的
 * Releases 地址，而不是把用户更新请求打回默认仓库。
 */
export function resolveGithubPublishOwner(env = process.env) {
  const configured = env.NEKCODE_UPDATE_OWNER?.trim();
  return configured ? configured : DEFAULT_GITHUB_PUBLISH_OWNER;
}

export function resolveGithubPublishRepo(env = process.env) {
  const configured = env.NEKCODE_UPDATE_REPO?.trim();
  return configured ? configured : DEFAULT_GITHUB_PUBLISH_REPO;
}

export const ZCODE_PREVIEW_IDENTITY_ENV = "ZCODE_PREVIEW_IDENTITY";

const PRODUCTION_IDENTITY = Object.freeze({
  flavor: "production",
  appId: "ai.nekcode.desktop",
  productName: "nekcode",
  linuxExecutableName: "nekcode",
  linuxPackageName: "nekcode",
});

const PREVIEW_IDENTITY = Object.freeze({
  flavor: "preview",
  appId: "ai.nekcode.desktop.preview",
  productName: "nekcode-preview",
  linuxExecutableName: "nekcode-preview",
  linuxPackageName: "nekcode-preview",
});

export const desktopProductIdentities = Object.freeze({
  production: PRODUCTION_IDENTITY,
  preview: PREVIEW_IDENTITY,
});

function normalizeDesktopZCodeEnv(env) {
  return env.ZCODE_ENV?.trim().toLowerCase() === "production" ? "production" : "test";
}

/**
 * 开关只有一种开启拼写 `1`（`0` / 空 = 关闭），与 CI workflow 规则和 release 门的
 * `$ZCODE_PREVIEW_IDENTITY == "1"` 精确比较保持同一套语义。其它拼写在构建期直接失败，
 * 避免 `true` 之类在 YAML 路由层漏匹配、却在脚本层被当成开启，把 Preview 包打进生产验收目录。
 */
export function isPreviewIdentityRequested(env = process.env) {
  const value = env[ZCODE_PREVIEW_IDENTITY_ENV]?.trim() ?? "";
  if (value === "1") {
    return true;
  }
  if (value === "" || value === "0") {
    return false;
  }
  throw new Error(
    `invalid ${ZCODE_PREVIEW_IDENTITY_ENV}=${env[ZCODE_PREVIEW_IDENTITY_ENV]}; expected 1 or 0`,
  );
}

/**
 * 产品身份（flavor）与后端环境（`ZCODE_ENV`）是两个轴：
 * - `ZCODE_ENV=test` 一律是 Preview，测试后端不能顶着正式 `ZCode` 身份覆盖用户的正式安装；
 * - `ZCODE_ENV=production` 默认是正式身份，显式 `ZCODE_PREVIEW_IDENTITY=1` 时改用 Preview 身份。
 * 未知 `ZCODE_ENV` 继续按 test 处理，和共享层 normalizeZCodeEnv 的 fail-safe 默认值一致。
 */
export function resolveDesktopProductFlavor(env = process.env) {
  if (isPreviewIdentityRequested(env)) {
    return "preview";
  }
  return normalizeDesktopZCodeEnv(env) === "production" ? "production" : "preview";
}

export function resolveDesktopProductIdentity(env = process.env) {
  return desktopProductIdentities[resolveDesktopProductFlavor(env)];
}

/**
 * 产物文件名后缀标记的是后端环境而不是身份：`_TEST` 只出现在测试后端的安装包上。
 * 生产后端的 Preview 包靠 productName（`nekcode-preview-<version>-...`）与正式包区分。
 */
export function resolveDesktopArtifactSuffix(env = process.env) {
  return normalizeDesktopZCodeEnv(env) === "test" ? "_TEST" : "";
}

/**
 * 返回 Windows Shell 使用的 AppUserModelId。
 *
 * 打包态必须复用 electron-builder 的 appId，否则快捷方式里的 AUMID、开始菜单索引
 * 和运行中的 Electron 进程会被 Windows 视为三个不同的应用。开发态用 `.dev` 后缀的
 * 独立身份，避免本地调试快捷方式和正式/Preview 安装包互相污染。
 */
export function resolveWindowsAppUserModelIdForFlavor(flavor, runtime = { isPackaged: true }) {
  if (runtime.isPackaged === false) {
    return "ai.nekcode.desktop.dev";
  }
  return desktopProductIdentities[flavor === "preview" ? "preview" : "production"].appId;
}

export function resolveWindowsAppUserModelId(env = process.env, runtime = { isPackaged: true }) {
  return resolveWindowsAppUserModelIdForFlavor(resolveDesktopProductFlavor(env), runtime);
}
