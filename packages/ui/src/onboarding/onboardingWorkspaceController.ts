import { useCallback, useMemo, useState } from "react";
import { useNekHostApi } from "@/settings/nek/api/NekSettingsContext.js";
import { useOnboardingAction, type OnboardingActionHandle } from "./onboardingAction.js";
import type { OnboardingSelection } from "./onboardingFlow.js";

export interface OnboardingWorkspaceView {
  selection: OnboardingSelection | null;
  done: boolean;
  primaryActionId: "pickLocal" | "next";
}

export interface OnboardingWorkspaceController {
  view: OnboardingWorkspaceView;
  actions: {
    pickLocal: OnboardingActionHandle;
    openRemote: OnboardingActionHandle;
    clearSelection: OnboardingActionHandle;
  };
  setRemoteSelected: (selection: { connectionId: string; path: string; label: string }) => void;
}

export function useOnboardingWorkspaceController(options: {
  onOpenRemote: () => void;
}): OnboardingWorkspaceController {
  const api = useNekHostApi();
  const [selection, setSelection] = useState<OnboardingSelection | null>(null);
  const pickLocal = useOnboardingAction({
    action: async () => {
      const path = await api.pickDirectory();
      if (path !== null) setSelection({ kind: "local", path });
    },
    primary: selection === null,
  });
  const openRemote = useOnboardingAction({
    action: async () => options.onOpenRemote(),
  });
  const clearSelection = useOnboardingAction({
    action: async () => setSelection(null),
    visible: selection !== null,
  });
  const setRemoteSelected = useCallback(
    (remote: { connectionId: string; path: string; label: string }) =>
      setSelection({ kind: "remote", ...remote }),
    [],
  );
  const view = useMemo(
    () => ({
      selection,
      done: selection !== null,
      primaryActionId: selection === null ? ("pickLocal" as const) : ("next" as const),
    }),
    [selection],
  );
  return { view, actions: { pickLocal, openRemote, clearSelection }, setRemoteSelected };
}
