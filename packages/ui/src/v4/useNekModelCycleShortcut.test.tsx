// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useNekModelCycleShortcut } from "./useNekModelCycleShortcut.js";

const wrapper = ({ children }: { children: ReactNode }) => (
  <ZCodeIntlProvider initialLocale="en-US">{children}</ZCodeIntlProvider>
);
const ack: CommandAck = {
  commandId: "cycled",
  revisionAtDecision: 1,
  status: "accepted",
  result: {
    type: "cycleNekModel",
    selection: { providerId: "p", modelId: "next", options: { reasoningLevel: "high" } },
  },
};

it("SC-6 the model action submits one RPC and applies the returned model and thinking level", async () => {
  const response = Promise.withResolvers<CommandAck>();
  const sendCommand = vi.fn<(command: CommandEnvelope) => Promise<CommandAck>>(
    () => response.promise,
  );
  const selectModel = vi.fn();
  const selectThinking = vi.fn();
  const { result } = renderHook(
    () =>
      useNekModelCycleShortcut({
        sessionId: "session",
        sendCommand,
        readSelection: () => undefined,
        selectModel,
        selectThinking,
      }),
    { wrapper },
  );
  await act(async () => {
    const started = result.current.run();
    expect(await result.current.run()).toBe(false);
    response.resolve(ack);
    await started;
  });
  expect(sendCommand).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ type: "cycleNekModel", sessionId: "session", payload: {} }),
  );
  expect(selectModel).toHaveBeenCalledWith("p", "next");
  expect(selectThinking).toHaveBeenCalledWith("high");
});

it("SC-6 a late cycle response cannot change a different session's composer model", async () => {
  const response = Promise.withResolvers<CommandAck>();
  const sendCommand = vi.fn(() => response.promise);
  const selectModel = vi.fn();
  const { result, rerender } = renderHook(
    ({ sessionId }) =>
      useNekModelCycleShortcut({
        sessionId,
        sendCommand,
        readSelection: () => undefined,
        selectModel,
        selectThinking: vi.fn(),
      }),
    { wrapper, initialProps: { sessionId: "original" } },
  );
  act(() => {
    void result.current.run();
  });
  rerender({ sessionId: "new" });
  await act(async () => response.resolve(ack));
  expect(selectModel).not.toHaveBeenCalled();
});
