import { useCallback, type RefObject } from "react";
import type {
  CommandAck,
  ConversationRowTarget,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { MAX_V4_DRAFT_TEXT_BYTES, persistV4ComposerDraft } from "./composer/composerDraftStore.js";

/** Store the returned editor text under the child scope before navigation; never mutate the source draft. */
export function useConversationFork({
  sessionId,
  workspacePath,
  workspaceIdentity,
  snapshotRef,
  dispatch,
  onSessionCreated,
  onError,
}: {
  sessionId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  snapshotRef: RefObject<ConversationSnapshot | null>;
  dispatch: (
    type: "forkUserMessage",
    payload: { target: ConversationRowTarget },
    sessionId: string,
    revision: number,
    logEpoch: string,
  ) => Promise<CommandAck>;
  onSessionCreated?: (sessionId: string) => void;
  onError: (error: ZCodeUiError) => void;
}) {
  const { intl } = useZCodeIntl();
  return useCallback(
    (target: ConversationRowTarget) => {
      const snapshot = snapshotRef.current;
      if (!sessionId || !snapshot) return;
      void (async () => {
        try {
          const ack = await dispatch(
            "forkUserMessage",
            { target },
            sessionId!,
            snapshot.revision,
            snapshot.logEpoch,
          );
          if (ack.status === "noop" && ack.reasonCode === "guard.forkCancelled") return;
          if (ack.status !== "accepted" && ack.status !== "duplicate")
            throw new Error(ack.message ?? ack.reasonCode ?? ack.status);
          if (ack.result?.type !== "forkUserMessage") throw new Error("Missing fork result");
          const { sessionId: childSessionId, text } = ack.result;
          if (new TextEncoder().encode(text).byteLength > MAX_V4_DRAFT_TEXT_BYTES)
            throw new Error(intl.formatMessage({ id: "nek.conversation.forkDraftTooLarge" }));
          if (!persistV4ComposerDraft(workspacePath, workspaceIdentity, childSessionId, { text }))
            throw new Error(intl.formatMessage({ id: "nek.conversation.forkDraftFailed" }));
          if (snapshotRef.current?.sessionId === sessionId) onSessionCreated?.(childSessionId);
        } catch (error) {
          onError({
            code: "FORK_FAILED",
            message: intl.formatMessage({ id: "nek.conversation.forkFailed" }),
            detail: error instanceof Error ? error.message : String(error),
            taskId: sessionId!,
          });
        }
      })();
    },
    [
      intl,
      sessionId,
      workspacePath,
      workspaceIdentity,
      snapshotRef,
      dispatch,
      onSessionCreated,
      onError,
    ],
  );
}
