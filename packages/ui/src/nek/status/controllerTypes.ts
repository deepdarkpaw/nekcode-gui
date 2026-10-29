import type { KeyboardEvent } from "react";

export interface StatusMessage {
  id: string;
  values?: Record<string, string | number>;
}

export interface StatusActionHandle {
  visible: boolean;
  enabled: boolean;
  disabledReason?: StatusMessage;
  pending: boolean;
  error?: string;
  primary?: boolean;
  destructive?: boolean;
  shortcutActionId?: string;
  run: () => Promise<void>;
}

export type StatusKeyDown = (event: KeyboardEvent) => void;

export interface StatusFocusView<FocusId extends string = string> {
  target: FocusId | null;
  ref: (id: FocusId) => (element: HTMLElement | null) => void;
}

export const ACTION_BUSY: StatusMessage = { id: "ui.action.busy" };
