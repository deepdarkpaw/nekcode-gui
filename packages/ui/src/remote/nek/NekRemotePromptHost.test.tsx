// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import type { IRemoteInteractionHostApi, RemotePromptEvent } from "@zcode/shared/nek-protocol";
import { NekRemotePromptHost } from "./NekRemotePromptHost.js";
import { useRemotePromptQueueStore } from "./remotePromptQueueStore.js";
import { createNekTestEnv, installDomPolyfills } from "@/settings/nek/test/nekTestUtils.js";

installDomPolyfills();

function createApi(listenerRef: {
  current?: (event: RemotePromptEvent) => void;
}): IRemoteInteractionHostApi {
  return {
    onRemotePrompt: (listener) => {
      listenerRef.current = listener;
      return () => {
        listenerRef.current = undefined;
      };
    },
    respondRemotePrompt: vi.fn(async () => undefined),
    onRemoteConnectionStatus: () => () => undefined,
    retryNow: vi.fn(async () => undefined),
    cancelReconnect: vi.fn(async () => undefined),
  };
}

describe("NekRemotePromptHost", () => {
  it("renders the queue head host-key dialog", () => {
    const env = createNekTestEnv();
    const wrapper = ({ children }: { children: ReactNode }) => env.wrapper({ children });
    const listenerRef: { current?: (event: RemotePromptEvent) => void } = {};
    const api = createApi(listenerRef);
    useRemotePromptQueueStore.getState().reset();
    render(<NekRemotePromptHost api={api} onOpenKnownHosts={vi.fn()} />, { wrapper });

    act(() => {
      listenerRef.current?.({
        id: "prompt-1",
        connectionId: "connection-a",
        kind: "host_key",
        host: "example.test",
        port: 22,
        keyType: "ssh-ed25519",
        fingerprint: "SHA256:full-fingerprint-value",
      });
    });

    expect(screen.getByText("SHA256:full-fingerprint-value")).toBeTruthy();
    expect(screen.getByText("信任并连接")).toBeTruthy();
  });

  it("ZR-6 localizes host-key confirmations, warnings, and the pending queue", async () => {
    const listenerRef: { current?: (event: RemotePromptEvent) => void } = {};
    const api = createApi(listenerRef);
    const host = {
      connectionId: "connection-a",
      host: "example.test",
      port: 2222,
      keyType: "ssh-ed25519",
    };
    const { container } = render(
      <ZCodeIntlProvider initialLocale="en-US">
        <TooltipProvider>
          <NekRemotePromptHost api={api} onOpenKnownHosts={vi.fn()} />
        </TooltipProvider>
      </ZCodeIntlProvider>,
    );

    act(() => {
      listenerRef.current?.({
        ...host,
        id: "confirm",
        kind: "host_key",
        fingerprint: "SHA256:confirm",
      });
      listenerRef.current?.({
        ...host,
        id: "changed",
        kind: "host_key_changed",
        oldFingerprint: "SHA256:previous",
        newFingerprint: "SHA256:changed",
      });
    });

    expect(screen.getByRole("dialog", { name: "Connect to example.test:2222" })).toBeTruthy();
    expect(screen.getByText("Type")).toBeTruthy();
    expect(screen.getByText("Fingerprint")).toBeTruthy();
    expect(container.querySelector('[aria-label="Pending remote requests: 1"]')).not.toBeNull();

    act(() => useRemotePromptQueueStore.getState().removePrompt("confirm"));
    expect(
      await screen.findByRole("dialog", { name: "Host identity changed: example.test:2222" }),
    ).toBeTruthy();
    expect(screen.getByText("Previous fingerprint")).toBeTruthy();
    expect(screen.getByText("New fingerprint")).toBeTruthy();
  });
});

afterEach(() => {
  cleanup();
  useRemotePromptQueueStore.getState().reset();
});
