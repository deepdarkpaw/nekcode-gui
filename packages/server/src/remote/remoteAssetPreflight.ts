import type { IRemoteBackend } from "./backend.js";
import { runRemoteAssetCommand } from "./remoteAssetCommand.js";
import type { RemoteInstallAsset } from "./remoteAssetDeployDecision.js";
import { quotePosixPathArg, quotePosixShellArg } from "./posixShell.js";
import { buildServerBundleDeployCheck } from "./serverBundleDeployCheck.js";

type Sha256Tool = "sha256sum" | "shasum" | "openssl";

const MAX_MARKER_BYTES = 384;

/** 一条 exec 读取版本、能力、所有标记及文件存在性；待安装时再解释工具探测结果。 */
export async function probeRemoteAssets(
  backend: IRemoteBackend,
  appVersion: string,
  assets: readonly RemoteInstallAsset[],
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
  const script = [
    "set -eu",
    `probe_asset() {
      [ -f "$2" ] || return 0
      printf '%s-present\\t1\\n' "$1"
      if [ -f "$3" ] && [ -r "$3" ]; then
        printf '%s-marker\\t' "$1"
        head -c ${MAX_MARKER_BYTES + 1} < "$3" | base64 | tr -d '\\r\\n'
        printf '\\n'
      fi
    }`,
    ...assets.map(
      ({ component, remotePath, marker }) =>
        `probe_asset ${quotePosixShellArg(component.id)} ${quotePosixPathArg(remotePath)} ${quotePosixPathArg(marker.path)}`,
    ),
    buildServerBundleDeployCheck(appVersion),
    'for tool in sha256sum shasum openssl; do if command -v "$tool" >/dev/null 2>&1; then printf \'sha256\\t%s\\n\' "$tool"; break; fi; done',
    ...(backend.kind === "ssh"
      ? [
          "if command -v tar >/dev/null 2>&1; then printf 'tar\\t1\\n'; fi",
          `if command -v curl >/dev/null 2>&1; then
        printf 'downloader\\tcurl\\n'
      elif command -v wget >/dev/null 2>&1; then
        if command -v timeout >/dev/null 2>&1; then printf 'downloader\\twget\\n';
        else printf 'downloader\\twget-no-timeout\\n'; fi
      fi`,
        ]
      : []),
    "printf 'nek-deploy-probe-complete\\t1\\n'",
  ].join("\n");
  const { code, stdout, stderr } = await runRemoteAssetCommand(backend, script, signal);
  // 不把 SSH 断线/截断当成冷安装；probe 的完成帧必须存在。
  if (code !== 0 || !stdout.trimEnd().endsWith("nek-deploy-probe-complete\t1")) {
    throw new Error(`[deploy] remote asset probe failed (code=${code}): ${stderr.trim()}`);
  }
  const snapshot = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const split = line.indexOf("\t");
    if (split < 0) continue;
    const key = line.slice(0, split);
    const value = line.slice(split + 1);
    if (key.endsWith("-marker")) {
      const data = Buffer.from(value, "base64");
      if (data.length <= MAX_MARKER_BYTES) snapshot.set(key.slice(0, -7), data.toString());
    } else {
      snapshot.set(key, value);
    }
  }
  return snapshot;
}

export function requireRemoteSha256Tool(snapshot: ReadonlyMap<string, string>): Sha256Tool {
  const tool = snapshot.get("sha256");
  if (tool === "sha256sum" || tool === "shasum" || tool === "openssl") return tool;
  throw new Error("远端缺少 SHA256 校验工具，请安装 sha256sum、shasum 或 openssl 后重试。");
}

/** 从 stdin 读，避免文件名转义或路径空格改变摘要格式。 */
export function buildRemoteChecksumCommand(tool: Sha256Tool, file: string): string {
  if (tool === "sha256sum") return `sha256sum < ${file} | awk '{print $1}'`;
  if (tool === "shasum") return `shasum -a 256 < ${file} | awk '{print $1}'`;
  return `openssl dgst -sha256 < ${file} | awk '{print $NF}'`;
}
