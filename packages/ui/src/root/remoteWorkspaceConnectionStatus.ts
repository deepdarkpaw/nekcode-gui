import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";
import type { RemoteConnectionStatusEvent } from "@zcode/shared/nek-protocol";
import { buildWorkspaceSessionKey } from "@/lib/remoteWorkspaceHistory.js";
import { isWorkspaceTab, type WindowTabState } from "@/store/tabStore.js";

/** 自动重连复用既有项目行投影，按连接绑定的全部 tab 更新，不以当前激活项目过滤。 */
export function projectRemoteWorkspaceConnectionStatus(
  event: RemoteConnectionStatusEvent,
  tabs: readonly WindowTabState[],
  entries: readonly RemoteWorkspaceSessionEntry[],
  disconnectedMessage: string,
) {
  const keys = new Set(
    tabs.flatMap((tab) =>
      isWorkspaceTab(tab) && tab.remoteSessionId === event.connectionId
        ? [buildWorkspaceSessionKey(tab)]
        : [],
    ),
  );
  if (keys.size === 0) return null;
  const reconnecting = event.kind === "reconnecting" || event.kind === "disconnected";
  if (reconnecting) return { keys, reconnecting, entries };
  const connected = event.kind === "connected";
  const message =
    event.kind === "failed" ? event.message : connected ? undefined : disconnectedMessage;
  const status = connected ? ("connected" as const) : ("failed" as const);
  const next = entries.map((entry) => {
    if (
      !keys.has(buildWorkspaceSessionKey(entry)) ||
      (entry.lastConnectionStatus === status && entry.lastConnectionError === message)
    )
      return entry;
    return { ...entry, lastConnectionStatus: status, lastConnectionError: message };
  });
  return {
    keys,
    reconnecting,
    entries: next.every((entry, index) => entry === entries[index]) ? entries : next,
  };
}
