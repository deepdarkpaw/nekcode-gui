/**
 * Remote SSH interaction contract between the host process and renderer.
 *
 * The host owns SSH and reconnect state. The renderer only presents prompts,
 * sends answers, and renders the status events. IPC adapters may serialize
 * these types, but this file deliberately contains no transport code.
 */
import type { INekSettingsHostApi } from "./config-types.js";

export interface RemoteHostKeyPrompt {
  id: string;
  connectionId: string;
  kind: "host_key";
  host: string;
  port: number;
  keyType: string;
  /** OpenSSH-style `SHA256:<base64>` fingerprint. */
  fingerprint: string;
}

export interface RemotePassphrasePrompt {
  id: string;
  connectionId: string;
  kind: "passphrase";
  privateKeyPath?: string;
}

export interface RemotePasswordPrompt {
  id: string;
  connectionId: string;
  kind: "password";
  username: string;
  host: string;
}

export type RemotePromptRequest =
  | RemoteHostKeyPrompt
  | RemotePassphrasePrompt
  | RemotePasswordPrompt;

/** Sent by the host when a prompt has timed out, been aborted, or is no longer valid. */
export interface RemotePromptCancelledEvent {
  id: string;
}

export type RemotePromptEvent = RemotePromptRequest | RemotePromptCancelledEvent;

export type RemotePromptResponse = { accepted: boolean } | { value: string } | { cancelled: true };

export type RemotePromptListener = (event: RemotePromptEvent) => void;

export type RemoteConnectionStatusEvent =
  | { connectionId: string; kind: "connected" }
  | { connectionId: string; kind: "disconnected" }
  | {
      connectionId: string;
      kind: "reconnecting";
      attempt: number;
      max: number;
      nextDelayMs: number;
    }
  | { connectionId: string; kind: "failed"; message: string }
  | { connectionId: string; kind: "cancelled" };

export type RemoteConnectionStatusListener = (event: RemoteConnectionStatusEvent) => void;

/** Renderer-facing methods and event subscriptions for SSH prompts. */
export interface IRemotePromptHostApi {
  onRemotePrompt(listener: RemotePromptListener): () => void;
  respondRemotePrompt(id: string, response: RemotePromptResponse): Promise<void>;
}

/** Renderer-facing methods and event subscription for reconnect state. */
export interface IRemoteConnectionHostApi {
  onRemoteConnectionStatus(listener: RemoteConnectionStatusListener): () => void;
  retryNow(connectionId: string): Promise<void>;
  cancelReconnect(connectionId: string): Promise<void>;
}

export interface IRemoteInteractionHostApi extends IRemotePromptHostApi, IRemoteConnectionHostApi {}

/**
 * Settings v2 already owns known-host listing/removal and the nek install flow.
 * These aliases expose the exact existing methods without defining a second API.
 */
export type RemoteKnownHostsApi = Pick<INekSettingsHostApi, "listHosts" | "removeFingerprint">;

export type RemoteNekApi = Pick<INekSettingsHostApi, "testHost" | "installNek" | "cancelInstall">;
