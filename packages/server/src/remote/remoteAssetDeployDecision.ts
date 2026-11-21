import type { BundledRemoteManifest } from "@zcode/shared/bundled-remote-assets";
import { REMOTE_BASE } from "./deployShared.js";
import {
  matchesRemoteAssetMarker,
  remoteAssetMarker,
  type RemoteAssetMarker,
} from "./remoteAssetLiveIdentity.js";

type Component = BundledRemoteManifest["components"][number];
type ComponentId = Component["id"];

export interface RemoteInstallAsset {
  component: Component;
  entry: string;
  remotePath: string;
  executable: boolean;
  marker: RemoteAssetMarker;
}

const layout: Record<ComponentId, { path: string; executable: boolean }> = {
  "node-runtime": { path: "node", executable: true },
  "server-bundle": { path: "zcode-server.cjs", executable: false },
  "node-pty": { path: "build/Release/pty.node", executable: false },
  bfs: { path: "tools/bfs/bfs", executable: true },
  ripgrep: { path: "tools/ripgrep/rg", executable: true },
  ugrep: { path: "tools/ugrep/ugrep", executable: true },
};

export const REMOTE_NODE_PATH = `${REMOTE_BASE}/${layout["node-runtime"].path}`;
export const REMOTE_SERVER_PATH = `${REMOTE_BASE}/${layout["server-bundle"].path}`;

/** 固定安装顺序，不依赖 manifest 的组件排列。 */
export function remoteInstallAssets(manifest: BundledRemoteManifest): RemoteInstallAsset[] {
  const components = new Map(manifest.components.map((component) => [component.id, component]));
  return (Object.keys(layout) as ComponentId[]).map((id) => {
    const component = components.get(id);
    if (!component) throw new Error(`Bundled remote component missing: ${id}`);
    const { path, executable } = layout[id];
    return {
      component,
      entry: path.slice(path.lastIndexOf("/") + 1),
      remotePath: `${REMOTE_BASE}/${path}`,
      executable,
      marker: remoteAssetMarker(component, manifest.platformArch),
    };
  });
}

export function selectRemoteAssetsToDeploy(
  assets: readonly RemoteInstallAsset[],
  snapshot: ReadonlyMap<string, string>,
  platformArch: string,
  force: boolean,
): RemoteInstallAsset[] {
  if (force) return [...assets];
  return assets.filter((asset) => {
    const { component } = asset;
    if (!snapshot.has(`${component.id}-present`)) return true;
    if (component.id === "server-bundle" && snapshot.get("server-check") !== "0") return true;
    return !matchesRemoteAssetMarker(snapshot.get(component.id) ?? "", component, platformArch);
  });
}
