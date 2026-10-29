// @vitest-environment happy-dom
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  INITIAL_HOST_KEY_CONFIRM_STATE,
  reduceHostKeyConfirm,
  resolveHostKeyConfirmKey,
  useHostKeyConfirmController,
} from "./hostKeyController.js";
import { shouldTakeFocus } from "./remoteInteraction.js";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children });

const prompt = {
  id: "host-key-1",
  connectionId: "connection-a",
  kind: "host_key" as const,
  host: "server.example",
  port: 2222,
  keyType: "ssh-ed25519",
  fingerprint: "SHA256:full-fingerprint",
};

function keyEvent(key: string, focusTarget: string | null = "reject") {
  return {
    key,
    isComposing: false,
    keyCode: key === "Enter" ? 13 : 27,
    nativeEvent: { isComposing: false, keyCode: key === "Enter" ? 13 : 27 },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    focusTarget,
  } as unknown as React.KeyboardEvent;
}

describe("host key confirmation controller", () => {
  it("HK-1: exposes the full host identity, non-default port, and body message id", () => {
    const respond = vi.fn(async () => undefined);
    const { result } = renderHook(
      () =>
        useHostKeyConfirmController({
          open: true,
          prompt,
          respond,
          copyFingerprint: async () => undefined,
          onClose: () => undefined,
        }),
      { wrapper },
    );
    expect(result.current.view).toMatchObject({
      host: "server.example",
      port: 2222,
      keyType: "ssh-ed25519",
      fingerprint: "SHA256:full-fingerprint",
      body: { id: "remote.nek.hostKey.body" },
    });
  });

  it("HK-2: exposes verb labels and maps trust/reject/copy actions", async () => {
    const responses: unknown[] = [];
    const onClose = vi.fn();
    const { result } = renderHook(
      () =>
        useHostKeyConfirmController({
          open: true,
          prompt,
          respond: async (_id, response) => {
            responses.push(response);
          },
          copyFingerprint: async () => undefined,
          onClose,
        }),
      { wrapper },
    );
    expect(result.current.actions.trust.label).toEqual({ id: "remote.nek.hostKey.trust" });
    expect(result.current.actions.reject.label).toEqual({ id: "remote.nek.hostKey.reject" });
    expect(result.current.actions.copyFingerprint.label).toEqual({
      id: "remote.nek.hostKey.copyFingerprint",
    });
    await act(async () => result.current.actions.trust.run());
    expect(responses).toEqual([{ accepted: true }]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("HK-3: focuses reject by default and Enter activates only the focused action", async () => {
    const responses: unknown[] = [];
    const { result } = renderHook(
      () =>
        useHostKeyConfirmController({
          open: true,
          prompt: { ...prompt, port: 22 },
          respond: async (_id, response) => {
            responses.push(response);
          },
          copyFingerprint: async () => undefined,
          onClose: () => undefined,
        }),
      { wrapper },
    );
    expect(result.current.focus.target).toBe("reject");
    const event = keyEvent("Enter");
    act(() => result.current.onKeyDown(event));
    await act(async () => undefined);
    expect(responses).toEqual([{ accepted: false }]);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(result.current.view.port).toBeUndefined();
  });

  it("HK-4: Escape activates reject and IME Enter is left untouched", () => {
    expect(resolveHostKeyConfirmKey({ key: "Escape", focusTarget: "trust" })).toEqual({
      type: "activate",
      action: "reject",
    });
    expect(
      resolveHostKeyConfirmKey({ key: "Enter", focusTarget: "trust", isComposing: true }),
    ).toBeNull();
    expect(
      resolveHostKeyConfirmKey({ key: "Enter", focusTarget: "trust", keyCode: 229 }),
    ).toBeNull();
    expect(resolveHostKeyConfirmKey({ key: "Tab", focusTarget: "trust" })).toBeNull();
  });

  it("HK-5: keeps the prompt open and puts IPC errors on the action", async () => {
    const onClose = vi.fn();
    const { result } = renderHook(
      () =>
        useHostKeyConfirmController({
          open: true,
          prompt,
          respond: async () => {
            throw new Error("IPC unavailable");
          },
          copyFingerprint: async () => undefined,
          onClose,
        }),
      { wrapper },
    );
    await act(async () => result.current.actions.trust.run());
    expect(onClose).not.toHaveBeenCalled();
    expect(result.current.actions.trust.error).toContain("IPC unavailable");
    expect(result.current.actions.trust.enabled).toBe(true);
  });

  it("HK-3: safe focus policy does not steal an active input with content or selection", () => {
    expect(shouldTakeFocus({ kind: "input", hasContent: true, hasSelection: false })).toBe(false);
    expect(shouldTakeFocus({ kind: "textarea", hasContent: false, hasSelection: true })).toBe(
      false,
    );
    expect(shouldTakeFocus({ kind: "input", hasContent: false, hasSelection: false })).toBe(true);
  });

  it("HK-2: reducer marks trust/reject as closed and copy as copied", () => {
    const copied = reduceHostKeyConfirm(INITIAL_HOST_KEY_CONFIRM_STATE, { type: "copySucceeded" });
    expect(copied).toEqual({ closed: false, copied: true });
    expect(reduceHostKeyConfirm(copied, { type: "trust" }).closed).toBe(true);
    expect(reduceHostKeyConfirm(copied, { type: "copySucceeded" })).toBe(copied);
  });

  it("HK-3: Enter with no registered focus target is not handled", () => {
    expect(resolveHostKeyConfirmKey({ key: "Enter", focusTarget: null })).toBeNull();
  });
});
