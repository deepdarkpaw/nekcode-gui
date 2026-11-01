import { ZCODE_VERSION, type RemoteTarget } from "@zcode/shared";
import type {
  ConnectOptions,
  DeployLockMode,
  IRemoteBackend,
  RemoteConnection,
  RemoteRuntimeNetworkOptions,
} from "@zcode/server/remote";

/** Create one physical transport; the enclosing window entry owns retry and replacement. */
export async function setupRemoteConnection(
  target: RemoteTarget,
  remoteAssets: Pick<ConnectOptions, "bundledRemoteAssetsDir">,
  remoteRuntimeNetwork: RemoteRuntimeNetworkOptions | undefined,
  onDidRemoteClose: (exitCode: number) => void,
  deployLockMode: DeployLockMode = "remote",
  signal?: AbortSignal,
): Promise<RemoteConnection & { backend: IRemoteBackend }> {
  const { createRemoteBackend, connectRemote, pickRemoteRuntimeEnv } =
    await import("@zcode/server/remote");
  const backend = await createRemoteBackend(target);
  const connection = await connectRemote(backend, {
    ...remoteAssets,
    remoteRuntimeNetwork,
    signal,
    appVersion: ZCODE_VERSION,
    remoteRuntimeEnv: pickRemoteRuntimeEnv(process.env),
    deployLockMode,
    onDidRemoteClose: ({ code }) => onDidRemoteClose(code),
  });
  return { ...connection, backend };
}
