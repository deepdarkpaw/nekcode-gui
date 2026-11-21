import type { RemoteAssetTransferProgress } from "@zcode/shared";
import { bundledRemoteReleaseAssetName } from "@zcode/shared/bundled-remote-assets";
import { RemoteAssetCommandTimeoutError, runRemoteAssetCommand } from "./remoteAssetCommand.js";
import type { RemoteInstallAsset } from "./remoteAssetDeployDecision.js";
import {
  buildStagingPreparation,
  type RemoteAssetInstaller,
  type RemoteStagingOptions,
} from "./remoteAssetInstaller.js";
import { buildRemoteChecksumCommand } from "./remoteAssetPreflight.js";
import { quotePosixShellArg } from "./posixShell.js";

const RELEASE_ROOT = "https://github.com/deepdarkpaw/nekcode-gui/releases/download";
const CONNECT_TIMEOUT_SECONDS = 5;
const STALL_SECONDS = 20;
const LOW_SPEED_BYTES_PER_SECOND = 32 * 1024;
const BUDGET_BYTES_PER_SECOND = 128 * 1024;
const BASE_TRANSFER_SECONDS = 60;
const MAX_TRANSFER_SECONDS = 15 * 60;
const MAX_DOWNLOAD_ATTEMPTS = 2;
const WGET_KILL_GRACE_SECONDS = 2;
const PLAN_GRACE_SECONDS = 30;

function transferTimeoutSeconds(bytes: number): number {
  return Math.min(
    MAX_TRANSFER_SECONDS,
    BASE_TRANSFER_SECONDS + Math.ceil(bytes / BUDGET_BYTES_PER_SECOND),
  );
}

type Fallback = Extract<RemoteAssetTransferProgress, { remoteAssetTransfer: "upload-fallback" }>;
type DownloadFailure = Pick<Fallback, "reason" | "statusCode" | "exitCode">;
type Downloader = "curl" | "wget";

export class ReleaseAssetUnavailableError extends Error {
  constructor(readonly failure: DownloadFailure) {
    super(`Remote release download failed: ${failure.reason}`);
  }
}

function buildCurlDownload(): string {
  // -q 放在首位以禁用用户 curlrc，但沿用远端进程已有的代理变量。
  return `
run_fetch() {
  (ulimit -f "$blocks" && exec curl -q -fsSL --max-redirs 5 --proto '=https' --proto-redir '=https' \\
    --connect-timeout ${CONNECT_TIMEOUT_SECONDS} --speed-limit ${LOW_SPEED_BYTES_PER_SECOND} --speed-time ${STALL_SECONDS} \\
    --max-time "$attempt_limit" --retry ${MAX_DOWNLOAD_ATTEMPTS - 1} --retry-max-time "$attempt_limit" --max-filesize "$bytes" \\
    -w '%{http_code}' -o "$archive" "$url") > "$stage/http" 2> "$download_log" &
  wait_for_fetch
  http=$(cat "$stage/http")
  # 低速与硬超时都是 exit 28；只判最后一次尝试，不让重试前的低速覆盖最终超时。
  if [ "$fetch_code" -eq 28 ] && awk '/^curl: [(]28[)] / { stalled = /Operation too slow[.]/ } END { exit !stalled }' "$download_log"; then
    fetch_failure=stalled
  fi
}
`;
}

function buildWgetDownload(): string {
  // wget 通常只读小写代理变量；大小写同时存在时保留远端用户显式设置的小写值。
  // -T 同时覆盖 GNU/BusyBox 的读取超时；GNU 关闭内置重试，由该脚本统一控制尝试次数。
  return `
if [ -z "\${https_proxy+x}" ] && [ -n "\${HTTPS_PROXY+x}" ]; then export https_proxy="$HTTPS_PROXY"; fi
if [ -z "\${http_proxy+x}" ] && [ -n "\${HTTP_PROXY+x}" ]; then export http_proxy="$HTTP_PROXY"; fi
if [ -z "\${no_proxy+x}" ] && [ -n "\${NO_PROXY+x}" ]; then export no_proxy="$NO_PROXY"; fi
wget_gnu=0
if wget --version 2>/dev/null | awk 'NR == 1 && /^GNU Wget[[:space:]]/ { found=1 } END { exit !found }'; then
  wget_gnu=1
fi
run_fetch() {
  set -- -T ${STALL_SECONDS}
  if [ "$wget_gnu" -eq 1 ]; then
    set -- "$@" --tries=1 --dns-timeout=${CONNECT_TIMEOUT_SECONDS} --connect-timeout=${CONNECT_TIMEOUT_SECONDS}
  fi
  attempt=0
  while [ "$attempt" -lt ${MAX_DOWNLOAD_ATTEMPTS} ]; do
    attempt=$((attempt + 1))
    (ulimit -f "$blocks" && exec timeout -k ${WGET_KILL_GRACE_SECONDS} "$attempt_limit" wget "$@" -S -O "$archive" "$url") > /dev/null 2> "$download_log" &
    wait_for_fetch
    http=$(awk '/^[[:space:]]*HTTP\\/[0-9.]+ [1-5][0-9][0-9]/ { status=$2 } END { print status+0 }' "$download_log")
    [ "$fetch_code" -ne 0 ] || return 0
    case "$http" in 4[0-9][0-9]) break ;; esac
  done
  case "$fetch_code" in
    124|137|143) fetch_failure=timeout ;;
    *)
      if awk -v http="$http" '/^(Read error|wget: read error:).*[ (](Connection|Operation) timed out/ || (http >= 200 && http < 300 && /^wget: (download timed out|timeout)$/) { stalled=1 } END { exit !stalled }' "$download_log"; then
        fetch_failure=stalled
      fi ;;
  esac
}
`;
}

function buildDownloadFunctions(downloader: Downloader): string {
  return `
# 只在远端匹配工具的固定诊断文本；stderr 原文（可能含代理信息）不回传。
export LC_ALL=C
child=
watcher=
cleanup_download() {
  status=$?
  trap - 0 HUP INT TERM
  if [ -n "$watcher" ]; then kill "$watcher" 2>/dev/null || :; fi
  if [ -n "$child" ]; then kill "$child" 2>/dev/null || :; wait "$child" 2>/dev/null || :; fi
  if [ "$status" -ne 0 ]; then rm -rf "$stage"; fi
  exit "$status"
}
trap cleanup_download 0
trap 'exit 130' HUP INT TERM
# 无 TTY 的 sshd 也可能忽略 channel signal；stdin EOF 仍能终止下载。
parent=$$
exec 3<&0
(IFS= read -r ignored <&3 || kill -TERM "$parent" 2>/dev/null) >/dev/null 2>&1 &
watcher=$!
wait_for_fetch() {
  child=$!
  fetch_code=0
  wait "$child" || fetch_code=$?
  child=
}
fail_download() {
  printf 'nek-release-failure\\t%s\\t%s\\t%s\\n' "$1" "\${2:-0}" "\${3:-0}"
  exit 23
}
${downloader === "curl" ? buildCurlDownload() : buildWgetDownload()}
download_archive() {
  url=$1
  bytes=$2
  attempt_limit=$3
  fetch_failure=transport
  # 同时限制不提供 Content-Length 或旧版 curl 的下载体；最终仍用完整 SHA 验证。
  blocks=$(( (bytes + 511) / 512 + 1 ))
  run_fetch
  case "$http" in [45][0-9][0-9]) fail_download http "$http" "$fetch_code" ;; esac
  if [ "$fetch_code" -ne 0 ]; then fail_download "$fetch_failure" 0 "$fetch_code"; fi
}
`;
}

function buildArchiveStep(
  options: RemoteStagingOptions,
  asset: RemoteInstallAsset,
  appVersion: string,
  size: number,
  attemptLimit: number,
): string {
  const { component, entry } = asset;
  const name = bundledRemoteReleaseAssetName(appVersion, component.id);
  const url = quotePosixShellArg(`${RELEASE_ROOT}/v${appVersion}/${name}`);
  const checksum = buildRemoteChecksumCommand(options.sha256Tool, '"$archive"');
  const required = component.requiredPaths.map(quotePosixShellArg);
  return [
    "assert_owner",
    `download_archive ${url} ${size} ${attemptLimit}`,
    `test "$( ${checksum} )" = ${quotePosixShellArg(component.sha256)} || fail_download checksum`,
    'mkdir "$unpacked"',
    `tar -xzf "$archive" -C "$unpacked" ${required.join(" ")} || fail_download extract`,
    ...required.map(
      (path) =>
        `test -f "$unpacked"/${path} && test ! -L "$unpacked"/${path} || fail_download extract`,
    ),
    `command mv "$unpacked"/${quotePosixShellArg(entry)} "$stage"/${quotePosixShellArg(component.id)}`,
    'rm -rf "$unpacked" "$archive" "$stage/http" "$download_log"',
  ].join("\n");
}

function transportFailure(downloader: Downloader, code: number): Fallback["reason"] {
  if (downloader === "wget") {
    if (code === 5) return "tls";
    return "network";
  }
  if (code === 5 || code === 6) return "dns";
  if (code === 7) return "connect";
  if (code === 28) return "timeout";
  if (code === 35 || code === 51 || code === 60) return "tls";
  return "network";
}

function readDownloadFailure(output: string, downloader: Downloader): DownloadFailure | undefined {
  const match =
    /^nek-release-failure\t(http|checksum|extract|stalled|timeout|transport)\t(0|[45]\d\d)\t(\d{1,3})$/mu.exec(
      output,
    );
  if (!match) return;
  const exitCode = Number(match[3]);
  switch (match[1]) {
    case "http":
      return { reason: "http", statusCode: Number(match[2]) };
    case "checksum":
      return { reason: "checksum" };
    case "extract":
      return { reason: "extract" };
    case "stalled":
    case "timeout":
      return { reason: match[1], exitCode };
    default:
      return { reason: transportFailure(downloader, exitCode), exitCode };
  }
}

export class ReleaseDownloadAssetInstaller implements RemoteAssetInstaller {
  readonly mode = "release-download" as const;

  constructor(
    private readonly options: RemoteStagingOptions,
    private readonly release: {
      appVersion: string;
      snapshot: ReadonlyMap<string, string>;
      archiveSizes: ReadonlyMap<string, number>;
    },
  ) {}

  async stage(assets: readonly RemoteInstallAsset[]): Promise<void> {
    const { backend, signal, ownerToken, report } = this.options;
    const { appVersion, snapshot, archiveSizes } = this.release;
    signal?.throwIfAborted();
    const downloader = snapshot.get("downloader");
    if (downloader === "wget-no-timeout")
      throw new ReleaseAssetUnavailableError({ reason: "missing-timeout" });
    if (downloader !== "curl" && downloader !== "wget") {
      throw new ReleaseAssetUnavailableError({ reason: "missing-downloader" });
    }
    if (!snapshot.has("tar")) throw new ReleaseAssetUnavailableError({ reason: "missing-tar" });

    let totalBytes = 0;
    let planSeconds = PLAN_GRACE_SECONDS;
    const killGrace = downloader === "wget" ? WGET_KILL_GRACE_SECONDS : 0;
    const steps = assets.map((asset) => {
      const size = archiveSizes.get(asset.component.id);
      if (!size) throw new Error(`Invalid bundled archive size: ${asset.component.id}`);
      totalBytes += size;
      const attemptLimit = transferTimeoutSeconds(size);
      // curl 的 --retry-max-time 限制重试何时开始，不会截断已经开始的重试。
      planSeconds += MAX_DOWNLOAD_ATTEMPTS * (attemptLimit + killGrace);
      return buildArchiveStep(this.options, asset, appVersion, size, attemptLimit);
    });
    const script = [
      buildStagingPreparation(ownerToken, this.mode),
      'archive="$stage/archive.tar.gz"',
      'unpacked="$stage/unpacked"',
      'download_log="$stage/download.log"',
      buildDownloadFunctions(downloader),
      ...steps,
      "assert_owner",
      "printf '%s\\n' nek-release-staged",
    ].join("\n");

    const started = performance.now();
    report({ remoteAssetTransfer: this.mode, totalBytes });
    const { code, stdout } = await runRemoteAssetCommand(
      backend,
      script,
      signal,
      planSeconds * 1000,
    ).catch((error) => {
      signal?.throwIfAborted();
      if (error instanceof RemoteAssetCommandTimeoutError)
        throw new ReleaseAssetUnavailableError({ reason: "timeout" });
      throw error;
    });
    if (code === 23) {
      const failure = readDownloadFailure(stdout, downloader);
      if (failure) throw new ReleaseAssetUnavailableError(failure);
    }
    if (code !== 0 || !stdout.trimEnd().endsWith("nek-release-staged")) {
      // 文件权限、部署锁或 exec 失败不是可回退的网络错误，不把真正的安装故障盖掉。
      throw new Error(`[deploy] remote release staging failed (code=${code})`);
    }
    report({
      remoteAssetTransfer: this.mode,
      totalBytes,
      durationMs: Math.round(performance.now() - started),
    });
  }
}
