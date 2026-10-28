import { useMemo } from "react";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";

export interface OnboardingActionHandle {
  visible: boolean;
  enabled: boolean;
  disabledReason?: { id: string; values?: Record<string, string | number> };
  pending: boolean;
  error?: string;
  primary?: boolean;
  destructive?: boolean;
  shortcutActionId?: string;
  run: () => Promise<void>;
}

export function useOnboardingAction(options: {
  action: () => Promise<void>;
  visible?: boolean;
  enabled?: boolean;
  disabledReason?: { id: string; values?: Record<string, string | number> };
  primary?: boolean;
  destructive?: boolean;
  shortcutActionId?: string;
}): OnboardingActionHandle {
  const asyncAction = useAsyncAction(options.action, { successFeedbackMs: 1500 });
  const visible = options.visible ?? true;
  const enabled = visible && (options.enabled ?? true) && asyncAction.state.status !== "pending";
  const disabledReason = enabled
    ? undefined
    : options.disabledReason ?? { id: "ui.action.busy" };
  return useMemo(
    () => ({
      visible,
      enabled,
      disabledReason,
      pending: asyncAction.state.status === "pending",
      error: asyncAction.state.status === "error" ? asyncAction.state.message : undefined,
      primary: options.primary,
      destructive: options.destructive,
      shortcutActionId: options.shortcutActionId,
      run: async () => {
        if (!enabled) return;
        await asyncAction.run();
      },
    }),
    [
      asyncAction,
      disabledReason,
      enabled,
      options.destructive,
      options.primary,
      options.shortcutActionId,
      visible,
    ],
  );
}
