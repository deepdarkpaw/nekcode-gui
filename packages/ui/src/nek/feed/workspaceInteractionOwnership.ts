/**
 * workspace 级 nek 交互卡（项目信任、未绑定会话的 dialog / structured）的去重登记。
 *
 * 同一个 workspace 可以开多个 pane，每个 pane 都有自己的 `V4PaneConversationProvider`；
 * 如果每个 pane 都渲染 `NekWorkspaceInteractionHost`，同一张卡会出现多次（回答一次就消失，
 * 但用户看到的是重复卡片）。这里让"渲染权"只属于一个 pane：
 *
 * 1. workspace 布局的 primary pane 在这个 workspace 上时，由 primary pane 渲染（稳定，符合
 *    "primary pane" 语义）；
 * 2. primary pane 绑的是别的 workspace（分屏可以拖别的 workspace 的会话进来）时，由 paneId
 *    字典序最小的 pane 渲染 —— 保证任何布局下都恰好有一个 pane 渲染，卡片不会丢；
 * 3. 不参与布局的侧栏（计划详情 / 子代理 / 选区侧聊）不登记，因此也不会渲染 workspace 卡。
 *
 * 登记项随 pane 卸载释放，因此表的规模只跟"当前挂载的 pane"有关，不是缓存。
 */
import { useEffect, useSyncExternalStore } from "react";

/** workspaceKey → (paneId → 该 pane 是否布局 primary)。 */
const claimsByWorkspace = new Map<string, Map<string, boolean>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

/**
 * 纯函数：从一个 workspace 的登记项里选出唯一渲染者。
 * primary 优先，否则取 paneId 字典序最小者，保证同一组 pane 得到同一答案。
 */
export function pickWorkspaceInteractionOwner(
  claims: ReadonlyMap<string, boolean>,
): string | undefined {
  let smallest: string | undefined;
  for (const [paneId, primary] of claims) {
    if (primary) return paneId;
    if (smallest === undefined || paneId < smallest) smallest = paneId;
  }
  return smallest;
}

function register(workspaceKey: string, paneId: string, primary: boolean): () => void {
  const panes = claimsByWorkspace.get(workspaceKey) ?? new Map<string, boolean>();
  claimsByWorkspace.set(workspaceKey, panes);
  panes.set(paneId, primary);
  notify();
  return () => {
    const current = claimsByWorkspace.get(workspaceKey);
    if (!current) return;
    current.delete(paneId);
    if (current.size === 0) claimsByWorkspace.delete(workspaceKey);
    notify();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface WorkspaceInteractionClaim {
  workspaceKey: string;
  paneId: string;
  /** 该 pane 是否是 workspace 布局的 primary pane。 */
  primary: boolean;
}

/** 测试用：清空登记表。 */
export function resetWorkspaceInteractionOwnership(): void {
  if (claimsByWorkspace.size === 0) return;
  claimsByWorkspace.clear();
  notify();
}

/** 诊断用：当前登记的 workspace 数量。 */
export function workspaceInteractionClaimCount(): number {
  return claimsByWorkspace.size;
}

function isOwner(workspaceKey: string | undefined, paneId: string | undefined): boolean {
  if (!workspaceKey || !paneId) return false;
  const panes = claimsByWorkspace.get(workspaceKey);
  return panes !== undefined && pickWorkspaceInteractionOwner(panes) === paneId;
}

/**
 * 当前 pane 是否负责渲染该 workspace 的交互卡。
 * `claim` 为 undefined（侧栏）时不登记，永远返回 false。
 */
export function useWorkspaceInteractionOwnership(
  claim: WorkspaceInteractionClaim | undefined,
): boolean {
  const workspaceKey = claim?.workspaceKey;
  const paneId = claim?.paneId;
  const primary = claim?.primary ?? false;
  useEffect(() => {
    if (!workspaceKey || !paneId) return;
    return register(workspaceKey, paneId, primary);
  }, [paneId, primary, workspaceKey]);
  return useSyncExternalStore(subscribe, () => isOwner(workspaceKey, paneId));
}
