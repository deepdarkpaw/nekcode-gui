/**
 * GitHub Release 发布：先建草稿并上传全部资产，最后一步才公开。
 *
 * 公开前资产必须齐全：用户不会看到缺安装包的半成品，electron-updater 也不会在
 * latest.yml 上传前读到新 Release 而 404。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 各平台的下载说明；只为发布里实际存在的平台生成。 */
const PLATFORM_DOWNLOADS = {
  win: (productName, version) =>
    `- Windows：\`${productName}-${version}-win-x64.exe\`（ARM 设备选 \`win-arm64\`）`,
  mac: (productName, version) =>
    `- macOS：\`${productName}-${version}-mac-arm64.dmg\`（Intel 芯片选 \`mac-x64\`）`,
};

/** 首次打开未签名安装包的操作提示。 */
const UNSIGNED_HINTS = {
  win: "Windows 弹出 SmartScreen 时点「更多信息 → 仍要运行」",
  mac: "macOS 首次打开时在「系统设置 → 隐私与安全性」里点「仍要打开」",
};

export function releaseTitle(productName, tag) {
  return `${productName} ${tag}`;
}

/** Release 正文：下载哪个文件、需要什么、未签名怎么打开、怎么校验。 */
export function releaseNotes({ productName, version, platforms }) {
  if (platforms.length === 0) throw new Error("Release must contain at least one platform");
  const downloads = platforms.map((platform) => {
    const line = PLATFORM_DOWNLOADS[platform];
    if (!line) throw new Error(`Unsupported release platform: ${platform}`);
    return line(productName, version);
  });
  const hints = platforms.map((platform) => UNSIGNED_HINTS[platform]).join("；");
  return [
    `${productName} 是终端编程助手 nek 的桌面图形界面。`,
    "",
    "### 下载",
    ...downloads,
    "",
    "### 说明",
    "- 需要 nek 0.4.0 或更新版本，首次启动的引导可以直接安装。",
    `- 已安装的 ${productName} 会自动检查这里的新版本。`,
    `- 安装包没有代码签名：${hints}。`,
    "- 下载后可以用 `SHA256SUMS` 校验文件。",
  ].join("\n");
}

/**
 * 发布 tag 对应的 Release。已公开的 Release 拒绝覆盖；上次失败留下的草稿会被复用
 * （保留其正文，覆盖上传资产）。prerelease tag（带 `-`）不标记为最新版。
 */
export async function publishRelease({ tag, repo, files, title, notes, run = execFileAsync }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid GitHub repository");
  const gh = (args) => run("gh", [...args, "--repo", repo], { maxBuffer: 4 * 1024 * 1024 });
  // 查询失败必须阻断写入，不能把网络或鉴权故障误当成 Release 不存在。
  const { stdout } = await gh(["release", "list", "--limit", "1000", "--json", "tagName,isDraft"]);
  const existing = JSON.parse(stdout).find((release) => release.tagName === tag);
  if (existing && !existing.isDraft) {
    throw new Error(`Refusing to overwrite published release ${tag}`);
  }
  const prerelease = tag.includes("-");
  if (!existing) {
    await gh([
      "release",
      "create",
      tag,
      "--verify-tag",
      "--draft",
      ...(prerelease ? ["--prerelease"] : []),
      "--title",
      title,
      "--notes",
      notes,
      "--generate-notes",
    ]);
  }
  await gh(["release", "upload", tag, ...files, "--clobber"]);
  await gh(["release", "edit", tag, "--draft=false", ...(prerelease ? [] : ["--latest"])]);
}
