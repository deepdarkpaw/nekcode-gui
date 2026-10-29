// @vitest-environment happy-dom
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  reduceRemoteConnectionStatus,
  useRemoteConnectionStatusController,
  type RemoteConnectionClock,
  type RemoteConnectionStatusSource,
} from "./connectionStatusController.js";
import type { RemoteConnectionStatusEvent } from "@zcode/shared/nek-protocol";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children });

class FakeIntervalClock implements RemoteConnectionClock {
  nowValue = 0;
  private nextId = 0;
  private callbacks = new Map<number, () => void>();

  now(): number {
    return this.nowValue;
  }

  setInterval(callback: () => void): number {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return id;
  }

  clearInterval(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  tick(): void {
    for (const callback of this.callbacks.values()) callback();
  }
}

function sourceHarness(): {
  source: RemoteConnectionStatusSource;
  emit: (event: RemoteConnectionStatusEvent) => void;
} {
  let listener: ((event: RemoteConnectionStatusEvent) => void) | null = null;
  return {
    source: (nextListener) => {
      listener = nextListener;
      return () => {
        listener = null;
      };
    },
    emit: (event) => listener?.(event),
  };
}

const initialState = {
  connectionId: "connection-a",
  kind: "connected" as const,
  receivedAt: 0,
};

describe("remote connection status controller", () => {
  it("CS-1/CS-2: maps connected and disconnected views and action visibility", () => {
    const harness = sourceHarness();
    const clock = new FakeIntervalClock();
    const { result } = renderHook(
      () =>
        useRemoteConnectionStatusController({
          connectionId: "connection-a",
          onStatus: harness.source,
          retryNow: async () => undefined,
          cancelReconnect: async () => undefined,
          clock,
        }),
      { wrapper },
    );
    expect(result.current.view).toMatchObject({
      kind: "connected",
      tone: "neutral",
      message: { id: "remote.nek.status.connected" },
      banner: false,
    });
    expect(result.current.actions.retryNow.visible).toBe(false);
    act(() => harness.emit({ connectionId: "connection-a", kind: "disconnected" }));
    expect(result.current.view).toMatchObject({
      kind: "disconnected",
      tone: "warning",
      message: { id: "remote.nek.status.disconnected" },
      banner: true,
    });
    expect(result.current.actions.retryNow).toMatchObject({
      visible: true,
      enabled: true,
      primary: true,
      label: { id: "remote.nek.status.retryNow" },
    });
    expect(result.current.actions.cancel.visible).toBe(false);
  });

  it("CS-3: computes reconnect countdown with upward rounding and zero-state copy", () => {
    const harness = sourceHarness();
    const clock = new FakeIntervalClock();
    const { result } = renderHook(
      () =>
        useRemoteConnectionStatusController({
          connectionId: "connection-a",
          onStatus: harness.source,
          retryNow: async () => undefined,
          cancelReconnect: async () => undefined,
          clock,
        }),
      { wrapper },
    );
    act(() => {
      clock.nowValue = 1000;
      harness.emit({
        connectionId: "connection-a",
        kind: "reconnecting",
        attempt: 2,
        max: 5,
        nextDelayMs: 5000,
      });
    });
    expect(result.current.view).toMatchObject({
      kind: "reconnecting",
      message: {
        id: "remote.nek.status.reconnecting",
        values: { seconds: 5, attempt: 2, max: 5 },
      },
      banner: true,
    });
    expect(result.current.actions.retryNow.visible).toBe(true);
    expect(result.current.actions.cancel).toMatchObject({
      visible: true,
      enabled: true,
      label: { id: "remote.nek.status.cancel" },
    });
    act(() => {
      clock.nowValue = 5999;
      clock.tick();
    });
    expect(result.current.view.seconds).toBe(1);
    act(() => {
      clock.nowValue = 6000;
      clock.tick();
    });
    expect(result.current.view.message).toEqual({
      id: "remote.nek.status.reconnectingNow",
      values: { attempt: 2, max: 5 },
    });
  });

  it("CS-4/CS-5: truncates failed details and exposes retry for failed/cancelled", () => {
    const longMessage = `${"x".repeat(250)}\nsecond line`;
    const failed = reduceRemoteConnectionStatus(
      initialState,
      { connectionId: "connection-a", kind: "failed", message: longMessage },
      10,
    );
    expect(failed).toMatchObject({ kind: "failed", receivedAt: 10, message: longMessage });
    const cancelled = reduceRemoteConnectionStatus(
      failed,
      { connectionId: "connection-a", kind: "cancelled" },
      20,
    );
    expect(cancelled).toMatchObject({ kind: "cancelled", receivedAt: 20 });

    const harness = sourceHarness();
    const { result } = renderHook(
      () =>
        useRemoteConnectionStatusController({
          connectionId: "connection-a",
          onStatus: harness.source,
          retryNow: async () => undefined,
          cancelReconnect: async () => undefined,
        }),
      { wrapper },
    );
    act(() => harness.emit({ connectionId: "connection-a", kind: "failed", message: longMessage }));
    expect(result.current.view).toMatchObject({
      tone: "danger",
      message: { id: "remote.nek.status.failed" },
      failureMessage: "x".repeat(200),
      banner: true,
    });
    expect(result.current.actions.retryNow.label).toEqual({ id: "remote.nek.status.retry" });
    act(() => harness.emit({ connectionId: "connection-a", kind: "cancelled" }));
    expect(result.current.view).toMatchObject({
      tone: "muted",
      message: { id: "remote.nek.status.cancelled" },
    });
  });

  it("CS-6: retry and cancel are mutually disabled while one request is pending", async () => {
    const harness = sourceHarness();
    let resolveRetry: (() => void) | undefined;
    const retryNow = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    const { result } = renderHook(
      () =>
        useRemoteConnectionStatusController({
          connectionId: "connection-a",
          onStatus: harness.source,
          retryNow,
          cancelReconnect: async () => undefined,
        }),
      { wrapper },
    );
    act(() =>
      harness.emit({
        connectionId: "connection-a",
        kind: "reconnecting",
        attempt: 1,
        max: 3,
        nextDelayMs: 1000,
      }),
    );
    let pending: Promise<void> | undefined;
    await act(async () => {
      pending = result.current.actions.retryNow.run();
      await Promise.resolve();
    });
    expect(result.current.actions.retryNow.pending).toBe(true);
    expect(result.current.actions.cancel.enabled).toBe(false);
    expect(result.current.actions.cancel.disabledReason).toEqual({ id: "ui.action.busy" });
    resolveRetry?.();
    await act(async () => pending);
    expect(retryNow).toHaveBeenCalledWith("connection-a");
  });

  it("CS-7: emits reconnected only after a prior non-connected state, not on first connected", () => {
    const harness = sourceHarness();
    const onReconnected = vi.fn();
    renderHook(
      () =>
        useRemoteConnectionStatusController({
          connectionId: "connection-a",
          onStatus: harness.source,
          retryNow: async () => undefined,
          cancelReconnect: async () => undefined,
          onReconnected,
        }),
      { wrapper },
    );
    act(() => harness.emit({ connectionId: "connection-a", kind: "connected" }));
    expect(onReconnected).not.toHaveBeenCalled();
    act(() => harness.emit({ connectionId: "connection-a", kind: "disconnected" }));
    act(() => harness.emit({ connectionId: "connection-a", kind: "connected" }));
    expect(onReconnected).toHaveBeenCalledTimes(1);
  });

  it("CS-8: ignores other connections and has no close action", () => {
    const harness = sourceHarness();
    const { result } = renderHook(
      () =>
        useRemoteConnectionStatusController({
          connectionId: "connection-a",
          onStatus: harness.source,
          retryNow: async () => undefined,
          cancelReconnect: async () => undefined,
        }),
      { wrapper },
    );
    act(() =>
      harness.emit({
        connectionId: "connection-b",
        kind: "failed",
        message: "wrong connection",
      }),
    );
    expect(result.current.view.kind).toBe("connected");
    expect(result.current.actions).not.toHaveProperty("close");
  });

  it("CS-2/CS-3: reducer ignores a mismatched connection without changing its reference", () => {
    const state = reduceRemoteConnectionStatus(
      initialState,
      { connectionId: "connection-b", kind: "failed", message: "wrong" },
      100,
    );
    expect(state).toBe(initialState);
  });
});
