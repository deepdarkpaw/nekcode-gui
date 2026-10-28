import type {
  RemotePromptEvent,
  RemotePromptRequest,
  RemotePromptResponse,
} from "@zcode/shared/nek-protocol";
import type { HostKeyConfirmation } from "./sshKnownHosts.js";

const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
let nextPromptId = 0;

export type RemotePromptCancellationReason = "timeout" | "aborted" | "disconnected" | "superseded";

export interface RemotePromptClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: RemotePromptClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RemotePromptBrokerOptions {
  connectionId: string;
  host: string;
  username: string;
  emit: (event: RemotePromptEvent) => void;
  timeoutMs?: number;
  clock?: RemotePromptClock;
  idFactory?: () => string;
  /** Server has no shared logger module; callers can inject their structured warning sink. */
  onWarning?: (message: string) => void;
}

interface PendingPrompt {
  request: RemotePromptRequest;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  decode: (response: RemotePromptResponse) => unknown;
  fallback: unknown;
  timer: unknown;
  abortSignal?: AbortSignal;
  abortHandler?: () => void;
}

function defaultPromptId(connectionId: string): string {
  nextPromptId += 1;
  return `remote-prompt:${connectionId}:${nextPromptId}`;
}

function isCancelledResponse(response: RemotePromptResponse): response is { cancelled: true } {
  return "cancelled" in response;
}

/**
 * Bridges SSH callbacks to one renderer prompt at a time for one connection.
 *
 * The broker is deliberately transport-free. `emit` is the host's event port;
 * an IPC adapter can forward the event without making the SSH layer aware of IPC.
 */
export class RemotePromptBroker {
  readonly connectionId: string;
  readonly confirmHostKey: (
    confirmation: HostKeyConfirmation,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  readonly askPassphrase: (
    privateKeyPath?: string,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
  readonly askPassword: (signal?: AbortSignal) => Promise<string | undefined>;

  private readonly host: string;
  private readonly username: string;
  private readonly emit: (event: RemotePromptEvent) => void;
  private readonly timeoutMs: number;
  private readonly clock: RemotePromptClock;
  private readonly idFactory: () => string;
  private readonly onWarning: (message: string) => void;
  private pending: PendingPrompt | null = null;
  private rendererConnected = true;

  constructor(options: RemotePromptBrokerOptions) {
    this.connectionId = options.connectionId;
    this.host = options.host;
    this.username = options.username;
    this.emit = options.emit;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 0) {
      throw new Error("remote prompt timeoutMs must be a finite non-negative number");
    }
    this.clock = options.clock ?? systemClock;
    this.idFactory = options.idFactory ?? (() => defaultPromptId(this.connectionId));
    this.onWarning = options.onWarning ?? ((message) => console.warn(message));

    this.confirmHostKey = (confirmation, signal) =>
      this.prompt(
        {
          id: this.idFactory(),
          connectionId: this.connectionId,
          kind: "host_key",
          host: confirmation.host,
          port: confirmation.port,
          keyType: confirmation.keyType,
          fingerprint: confirmation.fingerprint,
        },
        false,
        signal,
        (response) => {
          if (isCancelledResponse(response)) return false;
          if (!("accepted" in response)) {
            throw new Error("invalid host_key response");
          }
          return response.accepted;
        },
      );
    this.askPassphrase = (privateKeyPath, signal) =>
      this.prompt(
        {
          id: this.idFactory(),
          connectionId: this.connectionId,
          kind: "passphrase",
          ...(privateKeyPath ? { privateKeyPath } : {}),
        },
        undefined,
        signal,
        (response) => {
          if (isCancelledResponse(response)) return undefined;
          if (!("value" in response)) {
            throw new Error("invalid passphrase response");
          }
          return response.value;
        },
      );
    this.askPassword = (signal) =>
      this.prompt(
        {
          id: this.idFactory(),
          connectionId: this.connectionId,
          kind: "password",
          username: this.username,
          host: this.host,
        },
        undefined,
        signal,
        (response) => {
          if (isCancelledResponse(response)) return undefined;
          if (!("value" in response)) {
            throw new Error("invalid password response");
          }
          return response.value;
        },
      );
  }

  get hasPendingPrompt(): boolean {
    return this.pending !== null;
  }

  /** Marks the renderer available again after a new event subscription is attached. */
  rendererDidConnect(): void {
    this.rendererConnected = true;
  }

  /** Ends all pending callbacks when the renderer transport disappears. */
  rendererDidDisconnect(): void {
    this.rendererConnected = false;
    this.cancelPendingPrompt("disconnected");
  }

  /** Emits the security notification used when known-host verification detects a changed key. */
  notifyHostKeyChanged(input: {
    host: string;
    port: number;
    keyType: string;
    oldFingerprint: string;
    newFingerprint: string;
  }): void {
    this.emit({
      id: this.idFactory(),
      connectionId: this.connectionId,
      kind: "host_key_changed",
      ...input,
    });
  }

  /** Alias for lifecycle adapters that call the broker's teardown `dispose`. */
  dispose(): void {
    this.rendererDidDisconnect();
  }

  /** Delivers a renderer answer; stale and duplicate ids are ignored. */
  respondRemotePrompt(id: string, response: RemotePromptResponse): boolean {
    const pending = this.pending;
    if (!pending || pending.request.id !== id) return false;
    let value: unknown;
    try {
      value = pending.decode(response);
    } catch {
      this.onWarning(
        `Invalid response for remote ${pending.request.kind} prompt; treating as cancel`,
      );
      this.cancelPendingPrompt("aborted");
      return true;
    }
    this.clearPending(pending);
    pending.resolve(value);
    return true;
  }

  private prompt<T>(
    request: RemotePromptRequest,
    fallback: T,
    signal: AbortSignal | undefined,
    decode: (response: RemotePromptResponse) => T,
  ): Promise<T> {
    if (!this.rendererConnected || signal?.aborted) return Promise.resolve(fallback);
    if (this.pending) this.cancelPendingPrompt("superseded");

    return new Promise<T>((resolve, reject) => {
      const pending: PendingPrompt = {
        request,
        resolve: (value) => resolve(value as T),
        reject,
        decode,
        fallback,
        timer: undefined,
      };
      pending.abortSignal = signal;
      pending.abortHandler = () => this.cancelPendingPrompt("aborted");
      this.pending = pending;
      pending.timer = this.clock.setTimeout(
        () => this.cancelPendingPrompt("timeout"),
        this.timeoutMs,
      );
      if (signal) signal.addEventListener("abort", pending.abortHandler, { once: true });

      try {
        this.emit(request);
      } catch (error) {
        this.clearPending(pending);
        reject(error);
      }
    });
  }

  private cancelPendingPrompt(reason: RemotePromptCancellationReason): void {
    const pending = this.pending;
    if (!pending) return;
    this.clearPending(pending);
    try {
      this.emit({ id: pending.request.id, reason });
    } finally {
      pending.resolve(pending.fallback);
    }
  }

  private clearPending(pending: PendingPrompt): void {
    if (this.pending !== pending) return;
    this.pending = null;
    this.clock.clearTimeout(pending.timer);
    if (pending.abortSignal && pending.abortHandler) {
      pending.abortSignal.removeEventListener("abort", pending.abortHandler);
    }
  }
}
