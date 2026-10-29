// @vitest-environment happy-dom
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  INITIAL_HOST_KEY_CHANGED_STATE,
  reduceHostKeyChanged,
  resolveHostKeyChangedKey,
  useHostKeyChangedController,
} from "./hostKeyChangedController.js";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children });

const notification = {
  id: "changed-1",
  connectionId: "connection-a",
  kind: "host_key_changed" as const,
  host: "server.example",
  port: 2222,
  keyType: "ssh-ed25519",
  oldFingerprint: "SHA256:old",
  newFingerprint: "SHA256:new",
};

function keyEvent(key: string) {
  return {
    key,
    isComposing: false,
    keyCode: key === "Enter" ? 13 : 27,
    nativeEvent: { isComposing: false, keyCode: key === "Enter" ? 13 : 27 },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.KeyboardEvent;
}

describe("host key changed controller", () => {
  it("HC-1: exposes both complete fingerprints and the blocking body message", () => {
    const { result } = renderHook(
      () =>
        useHostKeyChangedController({
          open: true,
          notification,
          onOpenKnownHosts: async () => undefined,
          onClose: () => undefined,
        }),
      { wrapper },
    );
    expect(result.current.view).toEqual({
      host: "server.example",
      port: 2222,
      keyType: "ssh-ed25519",
      oldFingerprint: "SHA256:old",
      newFingerprint: "SHA256:new",
      body: { id: "remote.nek.hostKeyChanged.body" },
      attention: false,
    });
  });

  it("HC-2: exposes only acknowledge and manage-hosts actions", async () => {
    const close = vi.fn();
    const manage = vi.fn(async () => undefined);
    const { result } = renderHook(
      () =>
        useHostKeyChangedController({
          open: true,
          notification,
          onOpenKnownHosts: manage,
          onClose: close,
        }),
      { wrapper },
    );
    expect(result.current.actions.close.label).toEqual({ id: "remote.nek.hostKeyChanged.close" });
    expect(result.current.actions.manageHosts.label).toEqual({
      id: "remote.nek.hostKeyChanged.manageHosts",
    });
    await act(async () => result.current.actions.manageHosts.run());
    expect(manage).toHaveBeenCalledWith("connection-a");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("HC-3: defaults to close and maps Escape to close", () => {
    const { result } = renderHook(
      () =>
        useHostKeyChangedController({
          open: true,
          notification: { ...notification, port: 22 },
          onOpenKnownHosts: async () => undefined,
          onClose: () => undefined,
        }),
      { wrapper },
    );
    expect(result.current.focus.target).toBe("close");
    expect(result.current.view.port).toBeUndefined();
    expect(resolveHostKeyChangedKey({ key: "Escape", focusTarget: "manageHosts" })).toEqual({
      type: "activate",
      action: "close",
    });
    expect(resolveHostKeyChangedKey({ key: "Enter", focusTarget: null })).toBeNull();
    expect(
      resolveHostKeyChangedKey({ key: "Enter", focusTarget: "close", keyCode: 229 }),
    ).toBeNull();
  });

  it("HC-2: Enter follows the currently focused safe action", async () => {
    const close = vi.fn();
    const { result } = renderHook(
      () =>
        useHostKeyChangedController({
          open: true,
          notification,
          onOpenKnownHosts: async () => undefined,
          onClose: close,
        }),
      { wrapper },
    );
    const event = keyEvent("Enter");
    act(() => result.current.onKeyDown(event));
    await act(async () => undefined);
    expect(close).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("HC-1/HC-2: reducer closes for either permitted action and never offers continuation", () => {
    const closed = reduceHostKeyChanged(INITIAL_HOST_KEY_CHANGED_STATE, { type: "manageHosts" });
    expect(closed).toEqual({ closed: true });
    expect(reduceHostKeyChanged(closed, { type: "close" })).toBe(closed);
  });

  it("HC-3: IME composition does not consume Escape or Enter", () => {
    expect(
      resolveHostKeyChangedKey({ key: "Escape", focusTarget: "close", isComposing: true }),
    ).toBeNull();
    expect(
      resolveHostKeyChangedKey({
        key: "Enter",
        focusTarget: "close",
        nativeEvent: { keyCode: 229 },
      }),
    ).toBeNull();
  });
});
