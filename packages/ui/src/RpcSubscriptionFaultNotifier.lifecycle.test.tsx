// @vitest-environment happy-dom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter, type IChannelSubscriptionFailure } from "@zcode/rpc";
import { toast, dismissToast } from "@/components/ui/toast.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { RpcSubscriptionFaultNotifier } from "./RpcSubscriptionFaultNotifier.js";
import {
  clearRpcSubscriptionFaults,
  registerRpcSubscriptionFault,
  useRpcSubscriptionFaultStore,
} from "./store/rpcSubscriptionFaultStore.js";

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn(), dismissToast: vi.fn() }));

function capability(id: string, attempt: number, retry: () => void = () => undefined) {
  const invalidated = new Emitter<void>();
  let live = true;
  const invalidate = () => {
    live = false;
    invalidated.fire();
  };
  const failure: IChannelSubscriptionFailure = {
    id,
    attempt,
    channelName: "svc",
    event: "onTick",
    error: new Error("attach failed"),
    onDidInvalidate: invalidated.event,
    isLive: () => live,
    retry: () => {
      invalidate();
      retry();
    },
  };
  return { failure, invalidate };
}

function mount() {
  return render(
    <ZCodeIntlProvider initialLocale="en-US">
      <RpcSubscriptionFaultNotifier />
    </ZCodeIntlProvider>,
  );
}

beforeEach(() => {
  clearRpcSubscriptionFaults();
  vi.clearAllMocks();
  let nextToastId = 1;
  vi.mocked(toast).mockImplementation(() => nextToastId++);
});

afterEach(() => {
  cleanup();
  clearRpcSubscriptionFaults();
});

describe("RPC notifier React lifecycle", () => {
  it("RPC-UI9: React-batched synchronous retry failure renders a fresh attempt with the same logical key", () => {
    const second = capability("connection:stream", 2);
    const first = capability("connection:stream", 1, () =>
      registerRpcSubscriptionFault(second.failure),
    );
    mount();
    act(() => registerRpcSubscriptionFault(first.failure));
    expect(toast).toHaveBeenCalledTimes(1);
    act(() => vi.mocked(toast).mock.calls[0]![1]!.onAction?.());
    expect(toast).toHaveBeenCalledTimes(2);
    expect(dismissToast).toHaveBeenCalledWith(1);
    expect(useRpcSubscriptionFaultStore.getState().faults[0]!.attempt).toBe(2);
    // User close releases the presentation/store entry without cancelling the business stream.
    act(() => vi.mocked(toast).mock.calls[1]![1]!.onDismiss?.());
    expect(useRpcSubscriptionFaultStore.getState().faults).toEqual([]);
    expect(second.failure.isLive()).toBe(true);
    expect(dismissToast).toHaveBeenCalledWith(2);
  });

  it("RPC-UI10: unmount closes every toast; remount restores live capabilities and invalidation clears them", () => {
    const first = capability("base:stream", 1);
    const second = capability("remote:stream", 1);
    const view = mount();
    act(() => {
      registerRpcSubscriptionFault(first.failure);
      registerRpcSubscriptionFault(second.failure);
    });
    expect(toast).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(dismissToast).toHaveBeenCalledWith(1);
    expect(dismissToast).toHaveBeenCalledWith(2);
    expect(useRpcSubscriptionFaultStore.getState().faults).toHaveLength(2);
    mount();
    expect(toast).toHaveBeenCalledTimes(4);
    act(() => {
      first.invalidate();
      second.invalidate();
    });
    expect(useRpcSubscriptionFaultStore.getState().faults).toEqual([]);
    expect(dismissToast).toHaveBeenCalledWith(3);
    expect(dismissToast).toHaveBeenCalledWith(4);
  });
});
