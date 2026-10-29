// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
    useRemotePromptQueueStore.getState().reset();
  });
});
