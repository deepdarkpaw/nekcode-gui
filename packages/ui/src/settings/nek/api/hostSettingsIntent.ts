import { stripRemoteTargetSecrets, type RemoteTarget } from "@zcode/shared";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";

export interface HostSettingsIntent {
  target: RemoteTarget;
  action: "settings" | "copy";
}

let pending: HostSettingsIntent | undefined;

/** In-memory, same-window navigation; never put workspace connection data in browser storage. */
export function openHostSettings(intent: HostSettingsIntent, openSettingsTab?: () => void): void {
  pending = { ...intent, target: stripRemoteTargetSecrets(intent.target) };
  setPendingSettingsSectionIntent("nekRemoteHosts");
  openSettingsTab?.();
}

export function consumeHostSettingsIntent(): HostSettingsIntent | undefined {
  const intent = pending;
  pending = undefined;
  return intent;
}
