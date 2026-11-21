import type { BundledRemoteManifest } from "@zcode/shared/bundled-remote-assets";
import { REMOTE_BASE } from "./deployShared.js";

export interface RemoteAssetMarker {
  path: string;
  contents: string;
}

type Component = BundledRemoteManifest["components"][number];

/** 两种传输模式沿用同一份身份：服务端取完整 SHA，其他组件保留内容寻址版本。 */
export function remoteAssetMarker(component: Component, platformArch: string): RemoteAssetMarker {
  switch (component.id) {
    case "server-bundle":
    case "node-runtime":
    case "node-pty": {
      const identity =
        component.id === "server-bundle"
          ? { sha256: component.sha256 }
          : { version: component.version };
      return {
        path: `${REMOTE_BASE}/.asset-components/${component.id}.json`,
        contents: `${JSON.stringify({ id: component.id, ...identity, platformArch })}\n`,
      };
    }
    default:
      return {
        path: `${REMOTE_BASE}/tools/${component.id}/.version`,
        contents: component.version,
      };
  }
}

export function matchesRemoteAssetMarker(
  remote: string,
  component: Component,
  platformArch: string,
): boolean {
  if (!remote) return false;
  if (!remoteAssetMarker(component, platformArch).path.endsWith(".json")) {
    return remote.trim() === component.version;
  }
  try {
    const meta = JSON.parse(remote);
    if (!meta || meta.id !== component.id || meta.platformArch !== platformArch) return false;
    if (meta.version !== undefined && typeof meta.version !== "string") return false;
    if (meta.sha256 !== undefined && typeof meta.sha256 !== "string") return false;
    return component.id === "server-bundle"
      ? meta.sha256?.trim().toLowerCase() === component.sha256
      : meta.version === component.version;
  } catch {
    return false;
  }
}
