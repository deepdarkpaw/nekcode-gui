import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import type { SessionConfigState } from "@zcode/shared/zcode-protocol-v4";

/** 只消费明确审批事实；重复快照不能把用户后来改回的模式再刷回全开放。 */
export function applyComposerPermissionGrant(
  draft: V4ComposerDraft,
  grant: SessionConfigState["permissionGrant"],
): V4ComposerDraft {
  if (!grant || draft.lastPermissionGrantId === grant.interactionId) return draft;
  return { ...draft, mode: "agent", lastPermissionGrantId: grant.interactionId };
}
