import { safeLogArgs, ZCODE_VERSION, type RemoteAssetTransferProgress } from "@zcode/shared";
import type { IRemoteBackend, RemoteEnvironment } from "./backend.js";
import { BundledRemoteSource } from "./bundledRemoteSource.js";
import {
  remoteInstallAssets,
  selectRemoteAssetsToDeploy,
  type RemoteInstallAsset,
} from "./remoteAssetDeployDecision.js";
import {
  commitRemoteAssets,
  LocalUploadAssetInstaller,
  type RemoteAssetInstaller,
  type RemoteStagingOptions,
} from "./remoteAssetInstaller.js";
import { probeRemoteAssets, requireRemoteSha256Tool } from "./remoteAssetPreflight.js";
import { acquireRemoteDeployLock, type RemoteDeployLockHandle } from "./remoteDeployLock.js";
import { assertSupportedRemoteEnvironment } from "./remotePlatformSupport.js";
import {
  ReleaseAssetUnavailableError,
  ReleaseDownloadAssetInstaller,
} from "./releaseDownloadAssetInstaller.js";

export interface DeployOptions {
  /** 取消当前远端连接初始化与其拥有的传输。 */
  signal?: AbortSignal;
  /** 桌面构建只读归档和可信清单。 */
  bundledRemoteAssetsDir?: string;
  force?: boolean;
  /** 等待远端安装根锁的总 deadline，默认 120 秒。 */
  deployLockAcquireTimeoutMs?: number;
}

const log = (...args: unknown[]) => console.log(...safeLogArgs(args));
const logWarn = (...args: unknown[]) => console.warn(...safeLogArgs(args));

function reportTransfer(progress: RemoteAssetTransferProgress): void {
  if (progress.remoteAssetTransfer === "upload-fallback") {
    logWarn(progress);
  } else {
    log(progress);
  }
}

async function stageAssets(
  source: BundledRemoteSource,
  assets: readonly RemoteInstallAsset[],
  snapshot: ReadonlyMap<string, string>,
  options: RemoteStagingOptions,
): Promise<RemoteAssetInstaller["mode"]> {
  if (options.backend.kind === "ssh") {
    const { manifest, archiveSizes } = await source.getSnapshot();
    const downloader = new ReleaseDownloadAssetInstaller(options, {
      appVersion: manifest.appVersion,
      snapshot,
      archiveSizes,
    });
    const started = performance.now();
    try {
      await downloader.stage(assets);
      return downloader.mode;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!(error instanceof ReleaseAssetUnavailableError)) throw error;
      options.report({
        remoteAssetTransfer: "upload-fallback",
        durationMs: Math.round(performance.now() - started),
        ...error.failure,
      });
    }
  }
  const uploader = new LocalUploadAssetInstaller(options, source);
  await uploader.stage(assets);
  return uploader.mode;
}

async function withDeployLock<T>(
  lock: RemoteDeployLockHandle,
  signal: AbortSignal | undefined,
  work: () => Promise<T>,
): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await work() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await lock.release();
  } catch (releaseError) {
    if (signal?.aborted) {
      // 连接取消可能已关闭 backend；锁持有者收到 EOF 后在远端回收 staging。
      logWarn("[deploy] lock release interrupted by connection cancellation", releaseError);
      signal.throwIfAborted();
    }
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, releaseError],
        "remote deployment and deploy-lock release both failed",
      );
    }
    throw releaseError;
  }
  signal?.throwIfAborted();
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/** 持锁探测、准备并提交组件；返回值仍表示是否替换了 gui-server 主 bundle。 */
export async function deployServer(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  options?: DeployOptions,
): Promise<boolean> {
  const platformArch = `${env.platform}-${env.arch}`;
  assertSupportedRemoteEnvironment(env);
  const signal = options?.signal;
  const source = new BundledRemoteSource({
    directory: options?.bundledRemoteAssetsDir ?? "",
    appVersion: ZCODE_VERSION,
    platformArch,
    signal,
  });
  try {
    // A ready remote needs only the trusted manifest, never the local archive payloads.
    const manifest = await source.getManifest();
    if (options?.force) await source.getSnapshot();
    const assets = remoteInstallAssets(manifest);
    // 窗口内连接可合并，但多个窗口或桌面实例仍共享同一远端安装根。
    const lock = await acquireRemoteDeployLock(backend, {
      acquireTimeoutMs: options?.deployLockAcquireTimeoutMs,
      signal,
    });
    return await withDeployLock(lock, signal, async () => {
      const snapshot = await probeRemoteAssets(backend, manifest.appVersion, assets, signal);
      const pending = selectRemoteAssetsToDeploy(
        assets,
        snapshot,
        platformArch,
        Boolean(options?.force),
      );
      if (!pending.length) {
        log("[deploy] verified remote components already match");
        return false;
      }
      const staging = {
        backend,
        ownerToken: lock.ownerToken,
        sha256Tool: requireRemoteSha256Tool(snapshot),
        signal,
        report: reportTransfer,
      };
      const mode = await stageAssets(source, pending, snapshot, staging);
      await commitRemoteAssets(staging, mode, pending);
      return pending.some(({ component }) => component.id === "server-bundle");
    });
  } finally {
    await source.dispose();
  }
}
