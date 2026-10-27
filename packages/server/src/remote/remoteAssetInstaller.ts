import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { join, posix } from "node:path";
import type { IRemoteBackend } from "@zcode/server/remote/backend.js";
import {
  buildRemoteExecutableReplaceCommand,
  buildRemoteMoveCommand,
  createRemoteAssetPlaceholderError,
  fileExists,
  type DeployLoggers,
  type RemoteAssetDeployOptions,
  waitForClose,
} from "@zcode/server/remote/deployShared.js";
import { quotePosixPathArg, quotePosixShellArg } from "@zcode/server/remote/posixShell.js";
import {
  detectRemoteAssetTools,
  type RemoteAssetTools,
  type RemoteSha256Tool,
} from "@zcode/server/remote/remoteAssetPreflight.js";

export interface RemoteAssetInstaller {
  readonly mode: "bundled-upload";
  resolveComponentVersion?(componentId: string): Promise<string | null>;
  resolveComponentSha256?(componentId: string): Promise<string | null>;
  installFile(params: {
    componentId: string;
    sourceRelativePath: string;
    remotePath: string;
    executable?: boolean;
    forceRefresh?: boolean;
  }): Promise<void>;
}

function throwIfRemoteAssetInstallAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  const error = new Error("Remote asset installation canceled");
  error.name = "AbortError";
  throw error;
}

function buildStaleRemoteStagingCleanupCommand(parentDir: string, patterns: string[]): string {
  const quotedParentDir = quotePosixPathArg(parentDir);
  const candidateExpressions = patterns.map((pattern) => {
    const literalPrefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
    return `${quotedParentDir}/${quotePosixShellArg(literalPrefix)}*`;
  });
  return [
    `for candidate in ${candidateExpressions.join(" ")}; do`,
    'test -e "$candidate" || continue',
    // SSH 取消会先释放旧 backend，不能再用旧凭据立即 cleanup。
    // 新连接只回收超过 24 小时的 ZCode owner staging，避免误删当前 owner 或正常时长内的活跃部署。
    'find "$candidate" -prune -mtime +0 -exec rm -rf {} + 2>/dev/null || true',
    "done",
  ].join("\n");
}

export function buildRemoteChecksumCommand(params: {
  tool: RemoteSha256Tool;
  filePath: string;
}): string {
  const file = quotePosixPathArg(params.filePath);
  if (params.tool === "sha256sum") {
    return `sha256sum ${file} | awk '{print $1}'`;
  }
  if (params.tool === "shasum") {
    return `shasum -a 256 ${file} | awk '{print $1}'`;
  }
  return `openssl dgst -sha256 ${file} | awk '{print $NF}'`;
}

export class LocalUploadAssetInstaller implements RemoteAssetInstaller {
  readonly mode = "bundled-upload" as const;
  private toolsPromise: Promise<RemoteAssetTools> | undefined;

  private async verifyUploadedFile(localPath: string, remotePath: string): Promise<void> {
    throwIfRemoteAssetInstallAborted(this.options.signal);
    this.toolsPromise ??= detectRemoteAssetTools(this.backend, this.loggers);
    const tools = await this.toolsPromise;
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(localPath)) hash.update(bytes);
    const expected = hash.digest("hex");
    throwIfRemoteAssetInstallAborted(this.options.signal);
    // SFTP/WSL 上传完成不等于落盘字节正确；校验必须早于正式文件替换。
    const command = buildRemoteChecksumCommand({ tool: tools.sha256, filePath: remotePath });
    const stream = await this.backend.exec(
      `test "$( ${command} )" = ${quotePosixShellArg(expected)}`,
    );
    await waitForClose(stream);
    throwIfRemoteAssetInstallAborted(this.options.signal);
  }

  constructor(
    private readonly backend: IRemoteBackend,
    private readonly options: RemoteAssetDeployOptions & {
      platformArch?: string;
      version?: string;
    },
    private readonly loggers: DeployLoggers,
  ) {}

  async resolveComponentVersion(componentId: string): Promise<string | null> {
    return (await this.options.resolveComponentVersion?.(componentId)) ?? null;
  }

  async resolveComponentSha256(componentId: string): Promise<string | null> {
    return (await this.options.resolveComponentSha256?.(componentId)) ?? null;
  }

  async tryResolveLocalPath(
    componentIds: string[],
    sourceRelativePath: string,
    forceRefresh = false,
  ): Promise<string | null> {
    const releaseDir =
      this.options.releaseDir ??
      (await this.options.resolveReleaseDir?.(componentIds, {
        forceRefresh,
      })) ??
      null;
    if (!releaseDir) {
      return null;
    }

    const localPath = join(releaseDir, sourceRelativePath);
    if (await fileExists(localPath)) {
      return localPath;
    }

    return null;
  }

  async resolveLocalPath(
    componentIds: string[],
    sourceRelativePath: string,
    forceRefresh = false,
  ): Promise<string> {
    const localPath = await this.tryResolveLocalPath(componentIds, sourceRelativePath, forceRefresh);
    if (localPath) {
      return localPath;
    }

    const releaseDir =
      this.options.releaseDir ??
      (await this.options.resolveReleaseDir?.(componentIds, {
        forceRefresh,
      })) ??
      null;
    if (!releaseDir) {
      throw createRemoteAssetPlaceholderError(
        this.options.platformArch ?? "<unknown>",
        this.options,
        componentIds.join(","),
      );
    }
    throw new Error(
      `[deploy] local remote asset not found: ${join(releaseDir, sourceRelativePath)} (component=${componentIds.join(",")})`,
    );
  }

  async installFile(params: {
    componentId: string;
    sourceRelativePath: string;
    remotePath: string;
    executable?: boolean;
    forceRefresh?: boolean;
  }): Promise<void> {
    throwIfRemoteAssetInstallAborted(this.options.signal);
    const localPath = await this.resolveLocalPath(
      [params.componentId],
      params.sourceRelativePath,
      Boolean(params.forceRefresh),
    );
    // 本地解包完成后仍需检查取消，不得让迟到 continuation 再写远端 staging。
    throwIfRemoteAssetInstallAborted(this.options.signal);
    // 多个 Desktop 实例或跨窗口连接可能同时部署到同一 distro/user。
    // 固定 `.new` 会互相覆盖 staging 文件，唯一 owner 路径保证失败清理和最终 rename 不串写。
    const tempRemotePath = `${params.remotePath}.new-${Date.now()}-${randomUUID()}`;
    this.loggers.log(
      `[remote-assets] uploading ${params.sourceRelativePath} to ${params.remotePath}`,
    );
    const remoteParentDir = posix.dirname(params.remotePath);
    const cleanupRemoteStaging = async (): Promise<void> => {
      try {
        const cleanupStream = await this.backend.exec(`rm -f ${quotePosixPathArg(tempRemotePath)}`);
        await waitForClose(cleanupStream);
      } catch (error) {
        this.loggers.logWarn(
          `[remote-assets] failed to clean owned file staging ${tempRemotePath}: ${String(error)}`,
        );
      }
    };

    try {
      const prepareCommands = [
        ...(this.options.signal
          ? [
              buildStaleRemoteStagingCleanupCommand(remoteParentDir, [
                `${posix.basename(params.remotePath)}.new-*`,
              ]),
            ]
          : []),
        `mkdir -p ${quotePosixPathArg(remoteParentDir)}`,
      ];
      const mkdirStream = await this.backend.exec(prepareCommands.join("\n"));
      await waitForClose(mkdirStream);
      await this.backend.upload(localPath, tempRemotePath, {
        signal: this.options.signal,
      });
      throwIfRemoteAssetInstallAborted(this.options.signal);
      await this.verifyUploadedFile(localPath, tempRemotePath);
      const stream = await this.backend.exec(
        params.executable
          ? buildRemoteExecutableReplaceCommand(tempRemotePath, params.remotePath)
          : buildRemoteMoveCommand(tempRemotePath, params.remotePath),
      );
      await waitForClose(stream);
    } catch (error) {
      // 文件替换失败时必须清理当前 owner 的 `.new-*` 文件，否则
      // Docker 非 root 场景会把 chmod 失败的宿主 owner 文件长期留在远端。
      // 取消路径可能已经释放 backend，不能用旧凭据再次 cleanup；由后续 janitor 回收。
      if (!this.options.signal?.aborted) {
        await cleanupRemoteStaging();
      }
      throw error;
    }
  }
}


