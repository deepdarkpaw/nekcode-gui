import type { PromptInputTrigger } from "@/lib/promptInputTriggers.js";

export type MentionPanelGroupId = "files" | "sessions";
export type SessionMentionWorkspaceScope = "current-workspace" | "same-authority-workspaces";

const CONTEXT_GROUP_ORDER: readonly MentionPanelGroupId[] = ["files", "sessions"];
const SESSION_GROUP_ORDER: readonly MentionPanelGroupId[] = ["sessions"];

/** `@` 只发现上下文，`#` 保留会话入口；技能候选只由 `/` 面板提供。 */
export function getMentionPanelGroupOrder(
  trigger: PromptInputTrigger | null | undefined,
): readonly MentionPanelGroupId[] {
  if (trigger === "@") return CONTEXT_GROUP_ORDER;
  if (trigger === "#") return SESSION_GROUP_ORDER;
  return [];
}

/**
 * `@` 与 `#` 虽然复用会话 provider，但产品范围不同。
 * 若在共享 provider 内无条件扩展 workspace，`@` 会被连带扩容；范围必须由触发器路由显式决定。
 */
export function getSessionMentionWorkspaceScope(
  trigger: PromptInputTrigger | null | undefined,
): SessionMentionWorkspaceScope {
  return trigger === "#" ? "same-authority-workspaces" : "current-workspace";
}
