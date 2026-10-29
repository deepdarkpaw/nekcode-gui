// @vitest-environment happy-dom
import { createElement } from "react";
import type { ReactNode } from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  INITIAL_CREDENTIAL_PROMPT_STATE,
  reduceCredentialPrompt,
  resolveCredentialKey,
  useCredentialPromptController,
  type CredentialPrompt,
} from "./credentialController.js";

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(ZCodeIntlProvider, { initialLocale: "zh-CN", children });

const passphrase: CredentialPrompt = {
  id: "credential-1",
  connectionId: "connection-a",
  kind: "passphrase",
  privateKeyPath: "~/.ssh/id_ed25519",
};
const password: CredentialPrompt = {
  id: "credential-2",
  connectionId: "connection-a",
  kind: "password",
  username: "alice",
  host: "server.example",
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

describe("credential prompt controller", () => {
  it("CR-1: derives passphrase and password title/description message ids", () => {
    const pass = renderHook(
      () =>
        useCredentialPromptController({
          open: true,
          prompt: passphrase,
          respond: async () => undefined,
          onClose: () => undefined,
        }),
      { wrapper },
    );
    expect(pass.result.current.view.title).toEqual({
      id: "remote.nek.credential.passphrase.title",
    });
    expect(pass.result.current.view.description).toEqual({
      id: "remote.nek.credential.passphrase.description",
      values: { path: "~/.ssh/id_ed25519" },
    });
    pass.unmount();

    const noPath = renderHook(
      () =>
        useCredentialPromptController({
          open: true,
          prompt: { ...passphrase, privateKeyPath: undefined },
          respond: async () => undefined,
          onClose: () => undefined,
        }),
      { wrapper },
    );
    expect(noPath.result.current.view.description).toEqual({
      id: "remote.nek.credential.passphrase.descriptionNoPath",
    });
    noPath.unmount();

    const pwd = renderHook(
      () =>
        useCredentialPromptController({
          open: true,
          prompt: password,
          respond: async () => undefined,
          onClose: () => undefined,
        }),
      { wrapper },
    );
    expect(pwd.result.current.view.title).toEqual({ id: "remote.nek.credential.password.title" });
    expect(pwd.result.current.view.description).toEqual({
      id: "remote.nek.credential.password.description",
      values: { username: "alice", host: "server.example" },
    });
  });

  it("CR-2: keeps value/reveal state in memory and toggles show/hide labels", async () => {
    const { result } = renderHook(
      () =>
        useCredentialPromptController({
          open: true,
          prompt: password,
          respond: async () => undefined,
          onClose: () => undefined,
        }),
      { wrapper },
    );
    expect(result.current.view.revealed).toBe(false);
    expect(result.current.view.toggleRevealLabel).toEqual({ id: "remote.nek.credential.show" });
    act(() => result.current.setValue("secret"));
    await act(async () => result.current.actions.toggleReveal.run());
    expect(result.current.view.value).toBe("secret");
    expect(result.current.view.revealed).toBe(true);
    expect(result.current.view.toggleRevealLabel).toEqual({ id: "remote.nek.credential.hide" });
  });

  it("CR-3: disables empty submit with the specified reason and submits a value", async () => {
    const responses: unknown[] = [];
    const { result } = renderHook(
      () =>
        useCredentialPromptController({
          open: true,
          prompt: password,
          respond: async (_id, response) => {
            responses.push(response);
          },
          onClose: () => undefined,
        }),
      { wrapper },
    );
    expect(result.current.actions.submit.enabled).toBe(false);
    expect(result.current.actions.submit.disabledReason).toEqual({
      id: "remote.nek.credential.empty",
      values: { kind: "密码" },
    });
    act(() => result.current.setValue("secret"));
    expect(result.current.actions.submit.enabled).toBe(true);
    await act(async () => result.current.actions.submit.run());
    expect(responses).toEqual([{ value: "secret" }]);
  });

  it("CR-4: cancel sends cancelled and closes", async () => {
    const responses: unknown[] = [];
    const close = vi.fn();
    const { result } = renderHook(
      () =>
        useCredentialPromptController({
          open: true,
          prompt: passphrase,
          respond: async (_id, response) => {
            responses.push(response);
          },
          onClose: close,
        }),
      { wrapper },
    );
    await act(async () => result.current.actions.cancel.run());
    expect(responses).toEqual([{ cancelled: true }]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(result.current.view.value).toBe("");
  });

  it("CR-5: starts on input, handles Enter/Escape, and never submits during IME composition", () => {
    const enter = resolveCredentialKey({ key: "Enter", value: "secret" });
    expect(enter).toEqual({ type: "activate", action: "submit" });
    expect(resolveCredentialKey({ key: "Enter", value: "" })).toBeNull();
    expect(resolveCredentialKey({ key: "Escape", value: "" })).toEqual({
      type: "activate",
      action: "cancel",
    });
    expect(resolveCredentialKey({ key: "Enter", value: "secret", isComposing: true })).toBeNull();
    expect(resolveCredentialKey({ key: "Enter", value: "secret", keyCode: 229 })).toBeNull();
  });

  it("CR-5: Enter submits the current value and Esc cancels through the controller", async () => {
    const responses: unknown[] = [];
    const { result } = renderHook(
      () =>
        useCredentialPromptController({
          open: true,
          prompt: password,
          respond: async (_id, response) => {
            responses.push(response);
          },
          onClose: () => undefined,
        }),
      { wrapper },
    );
    act(() => result.current.setValue("secret"));
    const enter = keyEvent("Enter");
    act(() => result.current.onKeyDown(enter));
    await act(async () => undefined);
    expect(responses).toEqual([{ value: "secret" }]);
    expect(enter.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("CR-6/CR-7: closing immediately clears the local credential and offers no remember action", async () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) =>
        useCredentialPromptController({
          open,
          prompt: password,
          respond: async () => undefined,
          onClose: () => undefined,
        }),
      { initialProps: { open: true }, wrapper },
    );
    act(() => result.current.setValue("must-not-persist"));
    expect(result.current.view.value).toBe("must-not-persist");
    rerender({ open: false });
    expect(result.current.view.value).toBe("");
    expect(Object.keys(result.current.actions)).toEqual(["submit", "cancel", "toggleReveal"]);
  });

  it("CR-3/CR-4: a failed response keeps the prompt open and preserves value", async () => {
    const close = vi.fn();
    const { result } = renderHook(
      () =>
        useCredentialPromptController({
          open: true,
          prompt: password,
          respond: async () => {
            throw new Error("transport failed");
          },
          onClose: close,
        }),
      { wrapper },
    );
    act(() => result.current.setValue("secret"));
    await act(async () => result.current.actions.submit.run());
    expect(result.current.view.value).toBe("secret");
    expect(result.current.actions.submit.error).toContain("transport failed");
    expect(close).not.toHaveBeenCalled();
  });

  it("CR-2: reducer resets all sensitive state on close", () => {
    const state = reduceCredentialPrompt(INITIAL_CREDENTIAL_PROMPT_STATE, {
      type: "setValue",
      value: "secret",
    });
    const revealed = reduceCredentialPrompt(state, { type: "toggleReveal" });
    expect(reduceCredentialPrompt(revealed, { type: "close" })).toEqual({
      value: "",
      revealed: false,
      closed: true,
    });
  });
});
