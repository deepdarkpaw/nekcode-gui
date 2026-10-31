import { useCallback, useEffect, type ReactNode } from "react";
import type {
  NekAskQuestionPayload,
  NekExtensionUiDialogRequest,
  NekExtensionUiResponse,
  NekPlanReviewPayload,
  NekStructuredUiRequest,
  NekSwitchModePayload,
} from "@zcode/shared/nek-protocol";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { ActiveElementInfo } from "./interactionCommon.js";
import { NekAskQuestionCard } from "./NekAskQuestionCard.js";
import { NekExtensionDialogCard } from "./NekExtensionDialogCard.js";
import { NekPlanReviewCard } from "./NekPlanReviewCard.js";
import { NekSwitchModeCard } from "./NekSwitchModeCard.js";
import { useNekInteractionStore, type NekInteractionStoreApi } from "./interactionStore.js";

export interface NekInteractionHostProps {
  sessionKey: string;
  store?: NekInteractionStoreApi;
  workspacePath?: string;
  workspaceIdentity?: string;
  activeElement?: ActiveElementInfo;
  onOpenPlanFile?: (path: string) => Promise<void> | void;
  focusComposer?: () => void;
  onLostText?: (text: string) => void;
}

function extensionResponse(
  id: string,
  response: { result: unknown } | { cancelled: true },
): NekExtensionUiResponse {
  return { type: "extension_ui_response", id, ...response };
}

/** Host the current session's FIFO head; controllers remain the only interaction owners. */
export function NekInteractionHost({
  sessionKey,
  store = useNekInteractionStore,
  workspacePath,
  workspaceIdentity,
  activeElement,
  onOpenPlanFile,
  focusComposer,
  onLostText,
}: NekInteractionHostProps) {
  const { intl } = useZCodeIntl();
  const effectCount = store((state) => state.sessions[sessionKey]?.effects.length ?? 0);
  const noticeCount = store((state) => state.sessions[sessionKey]?.notices.length ?? 0);
  useEffect(() => {
    if (effectCount > 0) {
      for (const effect of store.getState().takeEffects(sessionKey)) {
        if (effect.kind === "toast") {
          toast(effect.message, { variant: effect.level === "error" ? "warning" : effect.level });
        } else if (effect.kind === "setStatus" && effect.statusText?.trim()) {
          toast(`${effect.statusKey}: ${effect.statusText}`, { variant: "info" });
        } else if (effect.kind === "setWidget" && effect.widgetLines?.length) {
          toast(effect.widgetLines.join("\n"), { variant: "info" });
        } else if (effect.kind === "setTitle" && effect.title.trim()) {
          toast(effect.title, { variant: "info" });
        } else if (effect.kind === "replaceComposerText" && workspacePath) {
          useZCodeSessionStore
            .getState()
            .requestComposerTextInsert(workspacePath, effect.text, workspaceIdentity);
        }
      }
    }
    if (noticeCount > 0) {
      for (const notice of store.getState().takeNotices(sessionKey)) {
        toast(intl.formatMessage({ id: notice.id }));
      }
    }
  }, [effectCount, intl, noticeCount, sessionKey, store, workspaceIdentity, workspacePath]);
  const activeRequest = store((state) => state.sessions[sessionKey]?.queue[0]?.request);
  const queueLength = store((state) =>
    Math.max(0, (state.sessions[sessionKey]?.queue.length ?? 0) - 1),
  );
  const settle = useCallback(
    async (response: NekExtensionUiResponse) => {
      // 回答先送达后端再关闭卡片：失败时请求留在队列里，控制器把错误挂在动作上可以重试。
      // 送达通道由 feed 在订阅时按会话键注册（见 nek/feed/nekAgentFeed.ts）。
      const accepted = await store.getState().settleAsync(sessionKey, response.id, response);
      if (!accepted) throw new Error(`Interaction ${response.id} is no longer pending.`);
    },
    [sessionKey, store],
  );
  if (!activeRequest) return null;

  const common = { activeElement, isQueueHead: true, closedByHost: false } as const;
  let card: ReactNode = null;
  if (activeRequest.method === "structured") {
    const request = activeRequest as NekStructuredUiRequest;
    if (request.kind === "nek.ask_question") {
      const payload = request.payload as NekAskQuestionPayload;
      card = (
        <NekAskQuestionCard
          key={request.id}
          payload={payload}
          queueLength={queueLength}
          {...common}
          onSubmit={(result) => settle(extensionResponse(request.id, { result }))}
          onDismiss={() => settle(extensionResponse(request.id, { cancelled: true }))}
        />
      );
    } else if (request.kind === "nek.plan_review") {
      const payload = request.payload as NekPlanReviewPayload;
      card = (
        <NekPlanReviewCard
          key={request.id}
          payload={payload}
          {...common}
          onSubmit={(result) =>
            settle(
              "cancelled" in result
                ? extensionResponse(request.id, { cancelled: true })
                : extensionResponse(request.id, { result }),
            )
          }
          onOpenPlanFile={
            onOpenPlanFile ??
            (() => {
              throw new Error("Plan file opening is not configured.");
            })
          }
          focusComposer={focusComposer ?? (() => undefined)}
        />
      );
    } else if (request.kind === "nek.switch_mode") {
      const payload = request.payload as NekSwitchModePayload;
      card = (
        <NekSwitchModeCard
          key={request.id}
          payload={payload}
          {...common}
          onSubmit={(result) => settle(extensionResponse(request.id, { result }))}
        />
      );
    }
  } else {
    const request = activeRequest as NekExtensionUiDialogRequest;
    card = (
      <NekExtensionDialogCard
        key={activeRequest.id}
        request={request}
        {...common}
        onRespond={settle}
        onLostText={onLostText ?? (() => undefined)}
      />
    );
  }

  if (!card) return null;
  return (
    <div className="relative w-full" data-testid="nek-interaction-host">
      {queueLength > 0 ? (
        <span
          className="absolute right-3 top-3 z-10 rounded-full border border-card-border bg-card px-2 py-0.5 text-ui-xs font-medium text-foreground"
          aria-label={intl.formatMessage(
            { id: "nek.interaction.queue.waiting" },
            { count: queueLength },
          )}
          data-testid="nek-interaction-queue-badge"
        >
          +{queueLength}
        </span>
      ) : null}
      {card}
    </div>
  );
}
