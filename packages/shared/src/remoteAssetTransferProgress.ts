import { z } from "zod";

const failureReasons = [
  "missing-downloader",
  "missing-timeout",
  "missing-tar",
  "http",
  "dns",
  "connect",
  "tls",
  "timeout",
  "checksum",
  "extract",
  "network",
] as const;

const stats = {
  totalBytes: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 ** 3),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
};

export const remoteAssetTransferProgressSchema = z.discriminatedUnion("remoteAssetTransfer", [
  z.strictObject({ remoteAssetTransfer: z.literal("release-download"), ...stats }),
  z.strictObject({ remoteAssetTransfer: z.literal("bundled-upload"), ...stats }),
  z.strictObject({
    remoteAssetTransfer: z.literal("upload-fallback"),
    reason: z.enum(failureReasons),
    statusCode: z.number().int().min(100).max(599).optional(),
    exitCode: z.number().int().min(0).max(255).optional(),
    durationMs: z.number().int().nonnegative().max(86_400_000),
  }),
]);

export type RemoteAssetTransferProgress = z.infer<typeof remoteAssetTransferProgressSchema>;

const reasonText: Record<(typeof failureReasons)[number], string> = {
  "missing-downloader": "远端未安装 curl 或 wget",
  "missing-timeout": "远端仅有 wget，缺少限制总时长的 timeout 命令",
  "missing-tar": "远端未安装 tar",
  http: "GitHub 返回 HTTP 错误",
  dns: "远端 DNS 解析失败",
  connect: "远端无法连接 GitHub 或代理",
  tls: "远端 TLS 校验或握手失败",
  timeout: "远端下载超时",
  checksum: "SHA256 与桌面内置清单不一致",
  extract: "远端解压失败或归档缺少必要文件",
  network: "远端下载命令失败",
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** 连接进度使用固定词表和有界数值；不显示远端 stderr 或代理凭据。 */
export function formatRemoteAssetTransferProgress(progress: RemoteAssetTransferProgress): string {
  const time =
    progress.durationMs === undefined ? "" : `，用时 ${(progress.durationMs / 1000).toFixed(1)} 秒`;
  if (progress.remoteAssetTransfer === "upload-fallback") {
    const detail = progress.statusCode
      ? ` ${progress.statusCode}`
      : progress.exitCode
        ? `（退出码 ${progress.exitCode}）`
        : "";
    return `远端下载失败：${reasonText[progress.reason]}${detail}${time}；改用本机上传。`;
  }
  const source =
    progress.remoteAssetTransfer === "release-download"
      ? "远端从 GitHub Releases 下载"
      : "本机上传";
  const phase = progress.durationMs === undefined ? "正在" : "已完成";
  return `${phase}${source}（${formatSize(progress.totalBytes)}${time}）`;
}
