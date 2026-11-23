import type { IServiceAccessor } from "@zcode/services";
import type { TaskArchiveTarget } from "@/hooks/useConversationImport.js";
import { resolveWorkspaceServices } from "@/lib/workspaceServiceResolver.js";
import { isWorkspaceTab, type TabStore } from "@/store/tabStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

function activeArchiveTarget(tabs: TabStore, base: IServiceAccessor) {
  const { activeTabId, tabs: currentTabs } = tabs.getState();
  const tab = currentTabs.find((item) => item.id === activeTabId);
  if (!tab || !isWorkspaceTab(tab)) return null;
  const remoteState = useRemoteWorkspaceSessionStore.getState();
  // Never route a stale SSH tab by path: another host (or the local machine) can have that path too.
  const { workspacePath, workspaceIdentity, remoteSessionId, remoteTarget } = tab;
  const resolved = resolveWorkspaceServices(
    { workspacePath, workspaceIdentity, remoteSessionId },
    remoteState.baseServices ?? base,
    remoteState,
  );
  if ((remoteSessionId || remoteTarget) && !resolved?.isRemoteWorkspace) return null;
  if (!resolved?.services.zcodeAgentService) return null;
  return {
    tabId: tab.id,
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
    remoteSessionId: resolved.remoteSessionId,
    service: resolved.services.zcodeAgentService,
    activeTaskId: useZCodeSessionStore
      .getState()
      .getWorkspaceState(tab.workspacePath, tab.workspaceIdentity).activeTaskId,
  };
}

type ArchiveBinding = NonNullable<ReturnType<typeof activeArchiveTarget>>;

export function captureTaskArchiveTarget(
  tabs: TabStore,
  base: IServiceAccessor,
  from?: TaskArchiveTarget,
): ArchiveBinding {
  const binding = activeArchiveTarget(tabs, base);
  if (
    !binding ||
    (from &&
      (from.workspacePath !== binding.workspacePath ||
        (from.workspaceIdentity ?? "") !== (binding.workspaceIdentity ?? "") ||
        (from.remoteSessionId && from.remoteSessionId !== binding.remoteSessionId)))
  )
    throw new Error("fault.taskArchive.targetUnavailable");
  return binding;
}

/** A → B → A, attach replacement and task selection each invalidate this operation permanently. */
export function watchTaskArchiveTarget(
  tabs: TabStore,
  base: IServiceAccessor,
  binding: ArchiveBinding,
  onChange: () => void,
) {
  let current = true;
  const check = () => {
    if (!current) return;
    const next = activeArchiveTarget(tabs, base);
    current = Boolean(
      next &&
      next.tabId === binding.tabId &&
      next.workspacePath === binding.workspacePath &&
      next.workspaceIdentity === binding.workspaceIdentity &&
      next.remoteSessionId === binding.remoteSessionId &&
      next.service === binding.service &&
      next.activeTaskId === binding.activeTaskId,
    );
    if (!current) onChange();
  };
  const unsubs = [
    tabs.subscribe(check),
    useRemoteWorkspaceSessionStore.subscribe(check),
    useZCodeSessionStore.subscribe(check),
  ];
  return {
    isCurrent: () => {
      check();
      return current;
    },
    dispose: () => {
      for (const unsubscribe of unsubs) unsubscribe();
    },
  };
}
