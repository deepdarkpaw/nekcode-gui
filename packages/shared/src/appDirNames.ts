/**
 * nekcode 落盘命名空间的唯一来源。
 *
 * 品牌改名后本产品占 `~/.nek/gui`，nek 自己的配置占 `~/.nek/agent`（由 nek 维护，
 * GUI 只通过 `nekConfigService` 读写），两者同属 `~/.nek` 命名空间但互不覆盖。
 * 新增目录或文件名时必须引用这些常量，不要在业务代码里散落字面量，否则改名会再次漏改。
 */

/**
 * 用户级数据根目录子路径，即 `~/.nek/gui`（可被 ZCODE_DATA_BASE_DIR 改写基路径）。
 *
 * 该常量是多段相对路径：调用方一律用 `join(baseDir, ZCODE_USER_DATA_DIR_NAME)` 拼接，
 * 由 `node:path` 负责把 `/` 归一化成平台分隔符，因此 Windows / macOS / Linux 都得到
 * `<base>/.nek/gui`。不要用字符串加法（`base + "/" + NAME`）拼接，那会在 Windows 上
 * 得到混用分隔符的路径。
 */
export const ZCODE_USER_DATA_DIR_NAME = ".nek/gui";

/**
 * 换名前用户级数据根目录子路径，仅用于一次性迁移，不再作为读写目标。
 *
 * 上一个身份（基于 ZCodium 的 `.zcodium-exp`）写入的数据在这里；更早的 `.zcodium`
 * 已由上一版构建迁移进 `.zcodium-exp`，因此迁移链保持单跳即可覆盖全部存量用户。
 */
export const LEGACY_ZCODE_USER_DATA_DIR_NAME = ".zcodium-exp";

/** 迁移成功后写在旧根内的标记文件，防止下次启动重复灌入。 */
export const ZCODE_USER_DATA_MIGRATION_MARKER_FILE_NAME = ".migrated-to-nek-gui";

/**
 * 远端服务安装根目录子路径，即远端机器上的 `~/.nek/gui-server`。
 *
 * 远端部署把 gui-server、随包的 node 运行时与 native 资源都放进这个根
 * （见 ARD §4 与 `packages/server/src/remote/deployShared.ts`）。同样是多段相对路径：
 * 远端路径永远是 POSIX，拼接时必须用 `/` 或 `node:path/posix`，不能用本机 `path.join`。
 */
export const ZCODE_REMOTE_INSTALL_ROOT_DIR_NAME = ".nek/gui-server";

/** 用户级 App 配置子目录名，即 `~/.nek/gui/v2`。 */
export const ZCODE_APP_CONFIG_SUBDIR_NAME = "v2";

/** 工作区级配置目录名，即 `<workspace>/.zcodium`。 */
export const ZCODE_WORKSPACE_CONFIG_DIR_NAME = ".zcodium";

/** 工作区级 hooks 配置文件名（与 `.zcodium/config.json` 并存的一种形态）。 */
export const ZCODE_WORKSPACE_CONFIG_FILE_NAME = "zcodium.json";

/** 工作区文件搜索忽略规则文件名。 */
export const ZCODE_WORKSPACE_IGNORE_FILE_NAME = ".zcodiumignore";

/** 插件清单目录名，即 `<plugin>/.zcodium-plugin/plugin.json`。 */
export const ZCODE_PLUGIN_MANIFEST_DIR_NAME = ".zcodium-plugin";

/** 插件清单文件名。 */
export const ZCODE_PLUGIN_MANIFEST_FILE_NAME = "plugin.json";
