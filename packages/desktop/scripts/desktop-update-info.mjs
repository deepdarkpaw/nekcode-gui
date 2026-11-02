/**
 * electron-updater 更新元数据（latest*.yml）的命名与合并。
 *
 * 这些规则必须同时对齐两侧：electron-builder 写盘时的文件名（app-builder-lib
 * updateInfoBuilder 的 getUpdateInfoFileName）与 electron-updater 读取时的文件名
 * （Provider#getChannelFilePrefix / getCustomChannelName）。两侧任一处漂移都会让用户端
 * 直接 ERR_UPDATER_CHANNEL_FILE_NOT_FOUND，因此集中在这里，产物收集、发布校验与测试都复用同一函数。
 *
 * 与 desktop-release.mjs 分文件的原因：发布脚本已接近 lint 的行数上限，而这里的命名与合并逻辑
 * 完全由字符串与 YAML 文档驱动，可以独立测试，不需要 artifact 命名与 gh 上传上下文。
 */
import { readFile } from "node:fs/promises";

/**
 * `yaml` 按需加载：desktop-release.mjs 的 `check-version` 在 CI 的 checks job 里跑于依赖安装之前
 * （标签错误要快速失败，不该先花一次 pnpm install），顶层静态导入会让那一步直接 MODULE_NOT_FOUND。
 */
async function loadYaml() {
  return import("yaml");
}

/**
 * 平台后缀：Windows 的通道文件名不带平台后缀，macOS 为 `-mac`。
 * 不发布 Linux 桌面包（Linux 只作为 SSH 远程主机），因此没有 `-linux` 通道。
 */
const UPDATE_INFO_PLATFORM_SUFFIX = { win: "", mac: "-mac" };
export const RELEASE_ARCHES = ["x64", "arm64"];

function asString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 返回 electron-updater 会拉取的通道文件名。
 *
 * `flavor` 为 `preview` 时使用 `latest-preview` 通道：Preview 与正式包发布在同一次
 * Release 里，如果两者都写 `latest.yml`，后上传的一份会覆盖另一份，正式用户的更新就会
 * 指向 Preview 安装包。
 */
export function updateInfoChannelName(platform, flavor, arch) {
  if (!Object.hasOwn(UPDATE_INFO_PLATFORM_SUFFIX, platform))
    throw new Error(`Unsupported platform: ${platform}`);
  if (!RELEASE_ARCHES.includes(arch)) throw new Error(`Unsupported release arch: ${arch}`);
  const channel = flavor === "preview" ? "latest-preview" : "latest";
  return `${channel}${UPDATE_INFO_PLATFORM_SUFFIX[platform]}.yml`;
}

/** electron-builder 在打包输出目录里写的更新元数据文件名（固定 latest 通道）。 */
export function sourceUpdateInfoName(platform, arch) {
  return updateInfoChannelName(platform, "production", arch);
}

/** 一次发布涉及的全部更新元数据文件名（Windows/macOS × 各身份，两个架构合并成一份）。 */
export function releaseUpdateInfoNames(identities) {
  const names = new Set();
  for (const identity of identities)
    for (const platform of Object.keys(UPDATE_INFO_PLATFORM_SUFFIX))
      for (const arch of RELEASE_ARCHES)
        names.add(updateInfoChannelName(platform, identity.flavor, arch));
  return [...names].sort();
}

export async function readUpdateInfo(file) {
  const { parse } = await loadYaml();
  const document = parse(await readFile(file, "utf8"));
  if (typeof document !== "object" || document === null || Array.isArray(document))
    throw new Error(`Update info is not a mapping: ${file}`);
  return { document, file };
}

function requiredUpdateFile(entry, file) {
  const url = asString(entry?.url);
  const sha512 = asString(entry?.sha512);
  if (!url) throw new Error(`Update info entry without url in ${file}`);
  if (!sha512) throw new Error(`Update info entry without sha512 in ${file}: ${url}`);
  const size = Number(entry?.size);
  if (!Number.isInteger(size) || size <= 0)
    throw new Error(`Update info entry without size in ${file}: ${url}`);
  return {
    url,
    sha512,
    size,
    ...(Number.isInteger(entry?.blockMapSize) ? { blockMapSize: Number(entry.blockMapSize) } : {}),
  };
}

/**
 * 合并同一产品、同一平台下多个架构的 `latest*.yml`。
 *
 * Windows 与 macOS 的 x64 / arm64 安装包在各自 runner 上打包，electron-builder 会为每个
 * 架构写一份同名 `latest.yml` / `latest-mac.yml`。若原样上传，后一次上传会静默覆盖另一架构的
 * 元数据，arm64 用户永远收不到更新。这里按 url 去重合并 files[]——electron-updater 的
 * AppUpdater#resolveFiles 正是按 files[] 里的安装包名挑当前架构——并保留首份文档的
 * path/sha512 作为兼容字段。
 */
export function mergeUpdateInfo(documents) {
  if (documents.length === 0) throw new Error("No update info document to merge");
  const [primary] = documents;
  const version = asString(primary.document?.version);
  if (!version) throw new Error(`Update info without version: ${primary.file}`);
  const files = [];
  const seen = new Set();
  let releaseDate = "";
  for (const { document, file } of documents) {
    const documentVersion = asString(document?.version);
    if (documentVersion !== version)
      throw new Error(
        `Update info version mismatch: ${file} has ${documentVersion || "<empty>"}, expected ${version}`,
      );
    const entries = Array.isArray(document?.files) ? document.files : [];
    if (entries.length === 0) throw new Error(`Update info without files: ${file}`);
    for (const entry of entries) {
      const required = requiredUpdateFile(entry, file);
      if (seen.has(required.url)) continue;
      seen.add(required.url);
      files.push(required);
    }
    releaseDate = [releaseDate, asString(document?.releaseDate)].filter(Boolean).sort().at(-1);
  }
  const primaryFile = requiredUpdateFile(primary.document.files[0], primary.file);
  const merged = {
    version,
    files,
    path: asString(primary.document?.path) || primaryFile.url,
    sha512: asString(primary.document?.sha512) || primaryFile.sha512,
    ...(releaseDate ? { releaseDate } : {}),
  };
  return merged;
}

/** 序列化合并后的更新元数据（electron-updater 直接从 YAML 读，字段名必须与上游一致）。 */
export async function stringifyUpdateInfo(document) {
  const { stringify } = await loadYaml();
  return stringify(document);
}

export function asUpdateInfoString(value) {
  return asString(value);
}
