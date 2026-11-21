import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, posix } from "node:path";
import type { RemoteAssetTransferProgress } from "@zcode/shared";
import type { IRemoteBackend } from "./backend.js";
import type { BundledRemoteSource } from "./bundledRemoteSource.js";
import { expectRemoteAssetCommand } from "./remoteAssetCommand.js";
import type { RemoteInstallAsset } from "./remoteAssetDeployDecision.js";
import { buildRemoteChecksumCommand } from "./remoteAssetPreflight.js";
import { REMOTE_DEPLOY_LOCK_DIR } from "./remoteDeployLock.js";
import { quotePosixPathArg, quotePosixShellArg } from "./posixShell.js";

export interface RemoteAssetInstaller {
  readonly mode: "bundled-upload" | "release-download";
  /** 只准备已验证文件；正式文件与身份标记由 deployServer 统一提交。 */
  stage(assets: readonly RemoteInstallAsset[]): Promise<void>;
}

export interface RemoteStagingOptions {
  backend: IRemoteBackend;
  ownerToken: string;
  sha256Tool: Parameters<typeof buildRemoteChecksumCommand>[0];
  signal?: AbortSignal;
  report: (progress: RemoteAssetTransferProgress) => void;
}

function stagingDirectory(ownerToken: string, mode: RemoteAssetInstaller["mode"]): string {
  return `${REMOTE_DEPLOY_LOCK_DIR}/${ownerToken}-${mode}`;
}

function assertOwnerScript(ownerToken: string): string {
  return `assert_owner() {
    owner=$(cat ${quotePosixPathArg(`${REMOTE_DEPLOY_LOCK_DIR}/owner`)} 2>/dev/null) || return 1
    [ "$owner" = ${quotePosixShellArg(ownerToken)} ] || return 1
  }`;
}

export function buildStagingPreparation(
  ownerToken: string,
  mode: RemoteAssetInstaller["mode"],
): string {
  return [
    "set -eu",
    "umask 077",
    assertOwnerScript(ownerToken),
    "assert_owner",
    `stage=${quotePosixPathArg(stagingDirectory(ownerToken, mode))}`,
    // 不用 mkdir -p；锁被释放或接管后，迟到命令不能重新创建已退役的锁目录。
    'mkdir "$stage"',
  ].join("\n");
}

export class LocalUploadAssetInstaller implements RemoteAssetInstaller {
  readonly mode = "bundled-upload" as const;

  constructor(
    private readonly options: RemoteStagingOptions,
    private readonly source: BundledRemoteSource,
  ) {}

  async stage(assets: readonly RemoteInstallAsset[]): Promise<void> {
    const { backend, ownerToken, signal, sha256Tool, report } = this.options;
    const localDir = await this.source.resolveReleaseDir();
    const files = assets.map(({ component, entry }) => ({
      id: component.id,
      path: join(localDir, component.mount, entry),
    }));
    const sizes = await Promise.all(
      files.map(async ({ id, path }) => {
        const { size } = await stat(path);
        if (!size) throw new Error(`Bundled remote executable is empty: ${id}`);
        return size;
      }),
    );
    const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
    signal?.throwIfAborted();
    const started = performance.now();
    report({ remoteAssetTransfer: this.mode, totalBytes });
    await expectRemoteAssetCommand(
      backend,
      buildStagingPreparation(ownerToken, this.mode),
      signal,
      "nek-upload-staging-ready",
    );
    const directory = stagingDirectory(ownerToken, this.mode);
    const checks = ["set -eu", assertOwnerScript(ownerToken), "assert_owner"];
    for (const file of files) {
      signal?.throwIfAborted();
      const hash = createHash("sha256");
      for await (const bytes of createReadStream(file.path, { signal })) hash.update(bytes);
      const expected = quotePosixShellArg(hash.digest("hex"));
      const target = `${directory}/${file.id}`;
      await backend.upload(file.path, target, { signal, parentAlreadyExists: true });
      const checksum = buildRemoteChecksumCommand(sha256Tool, quotePosixPathArg(target));
      checks.push(
        `test "$( ${checksum} )" = ${expected} || { printf '%s\\n' 'SHA256 mismatch: ${file.id}' >&2; exit 1; }`,
      );
    }
    // 上传完成不等于落盘字节正确：同一条 exec 校验全部待提交文件。
    await expectRemoteAssetCommand(backend, checks.join("\n"), signal, "nek-upload-verified");
    report({
      remoteAssetTransfer: this.mode,
      totalBytes,
      durationMs: Math.round(performance.now() - started),
    });
  }
}

/** 只有已校验 staging 才能进入正式路径；中断时无 marker 的单件下次重装。 */
export async function commitRemoteAssets(
  options: RemoteStagingOptions,
  mode: RemoteAssetInstaller["mode"],
  assets: readonly RemoteInstallAsset[],
): Promise<void> {
  const { backend, ownerToken, signal } = options;
  const directory = stagingDirectory(ownerToken, mode);
  const prepare = ["set -eu", "umask 077", assertOwnerScript(ownerToken), "assert_owner"];
  const parents = new Set<string>();
  const replace: string[] = [];
  for (const {
    component: { id },
    remotePath,
    executable,
    marker,
  } of assets) {
    const sourceFile = quotePosixPathArg(`${directory}/${id}`);
    const sourceMarker = quotePosixPathArg(`${directory}/${id}.marker`);
    const targetFile = quotePosixPathArg(remotePath);
    const targetMarker = quotePosixPathArg(marker.path);
    parents.add(posix.dirname(remotePath));
    parents.add(posix.dirname(marker.path));
    prepare.push(
      `test -f ${sourceFile} && test ! -L ${sourceFile} || exit 1`,
      `test ! -d ${targetFile} && test ! -d ${targetMarker} || exit 1`,
      ...(executable ? [`command chmod +x ${sourceFile}`] : []),
      `printf %s ${quotePosixShellArg(marker.contents)} > ${sourceMarker}`,
    );
    replace.push(
      "assert_owner",
      `rm -f ${targetMarker}`,
      `command mv -fT ${sourceFile} ${targetFile}`,
      `command mv -fT ${sourceMarker} ${targetMarker}`,
    );
  }
  const paths = [...parents].map(quotePosixPathArg).join(" ");
  const checkFilesystem = [
    `mkdir -p ${paths}`,
    `stage_device=$(stat -c %d ${quotePosixPathArg(directory)})`,
    `for parent in ${paths}; do`,
    '  test "$(stat -c %d "$parent")" = "$stage_device" || { printf "%s\\n" "Remote install paths must share one filesystem for atomic replacement" >&2; exit 1; }',
    "done",
  ];
  // 同一文件系统且全部文件已准备好才开始 rename；不可在此阶段回到另一种传输模式。
  await expectRemoteAssetCommand(
    backend,
    [...prepare, ...checkFilesystem, ...replace].join("\n"),
    signal,
    "nek-assets-committed",
  );
}
