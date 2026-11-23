import { useEffect, useMemo, useRef } from "react";
import type { ModelSelection } from "@zcode/shared";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { toast } from "@/components/ui/toast.js";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { createCommandEnvelope } from "./commandFactory.js";

interface ModelCyclePorts {
  sessionId: string | null;
  sendCommand: (envelope: CommandEnvelope) => Promise<CommandAck>;
  readSelection: () => ModelSelection | undefined;
  selectModel: (provider: string, model: string) => void;
  selectThinking: (level: string) => void;
}

/** nek owns the direction, order and thinking level; don't derive a second cycling list. */
export function useNekModelCycleShortcut({
  sessionId,
  sendCommand,
  readSelection,
  selectModel,
  selectThinking,
}: ModelCyclePorts) {
  const { intl } = useZCodeIntl();
  const scope = useMemo(() => ({}), [sessionId, sendCommand]);
  const active = useRef<object | null>(scope);
  active.current = scope;
  useEffect(() => {
    active.current = scope;
    return () => {
      if (active.current === scope) active.current = null;
    };
  }, [scope]);
  const { state, run } = useAsyncAction(
    async () => {
      if (!sessionId) {
        toast(intl.formatMessage({ id: "chat.slash.cycleNeedsSession" }), { variant: "info" });
        return;
      }
      const previous = readSelection();
      const ack = await sendCommand(
        createCommandEnvelope({ type: "cycleNekModel", payload: {}, sessionId }),
      );
      if (active.current !== scope) return;
      if (ack.status !== "accepted" || ack.result?.type !== "cycleNekModel") {
        throw new Error(ack.message ?? ack.reasonCode ?? ack.status);
      }
      const selection = ack.result.selection;
      if (!selection) {
        toast(intl.formatMessage({ id: "chat.slash.cycleNoOtherModel" }), { variant: "info" });
        return;
      }
      if (previous !== readSelection()) return; // Keep any newer explicit choice made while the RPC was pending.
      selectModel(selection.providerId, selection.modelId);
      const thinking = selection.options?.reasoningLevel;
      if (thinking !== undefined) selectThinking(thinking);
    },
    {
      successFeedbackMs: 0,
      onError: (error) => {
        if (active.current !== scope) return;
        const reason = error instanceof Error ? error.message : String(error);
        toast(
          intl.formatMessage({ id: "chat.slash.cycleFailed" }, { reason: reason.slice(0, 400) }),
          { variant: "warning" },
        );
      },
    },
  );
  return { pending: state.status === "pending", run };
}
