// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { useModelSelectionServiceView } from "./useModelSelectionView.js";

const VIEW: ModelSelectionView = {
  revision: 1,
  providers: [],
  scope: { patterns: [], models: [], diagnostics: [] },
};
function deferred() {
  let resolve!: (view: ModelSelectionView) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ModelSelectionView>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function host() {
  const listeners = new Map<() => void, string | undefined>();
  const getView = vi.fn(async () => VIEW);
  const service: IModelSelectionService = {
    getView,
    onDidChange: () => {
      throw new Error("renderer must lease its workspace, not the global event");
    },
    onDynamicDidChange:
      ({ workspacePath }) =>
      (listener) => {
        listeners.set(listener, workspacePath);
        return { dispose: () => listeners.delete(listener) };
      },
  };
  return {
    service,
    getView,
    listeners,
    invalidate() {
      for (const listener of listeners.keys()) listener();
    },
  };
}

describe("model selection read ownership", () => {
  it("ML3/ML7: watch bursts schedule one follow-up and continuous churn becomes retryable error", async () => {
    const fake = host();
    const first = deferred();
    const followUp = deferred();
    fake.getView
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => followUp.promise);
    const { result } = renderHook(() => useModelSelectionServiceView(fake.service));
    act(() => {
      for (let i = 0; i < 100; i++) fake.invalidate();
    });
    expect(fake.getView).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(VIEW));
    expect(fake.getView).toHaveBeenCalledTimes(2);
    act(() => {
      for (let i = 0; i < 100; i++) fake.invalidate();
    });
    await act(async () => followUp.resolve(VIEW));
    expect(fake.getView).toHaveBeenCalledTimes(2);
    expect(result.current.state.status).toBe("error");
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
  });

  it("ML4: dirty follow-up carries elapsed budget, not a reset deadline", async () => {
    const fake = host();
    const first = deferred();
    fake.getView.mockImplementationOnce(() => first.promise);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const { result } = renderHook(() => useModelSelectionServiceView(fake.service));
      clock.mockReturnValue(13000);
      act(() => fake.invalidate());
      await act(async () => first.resolve(VIEW));
      expect(fake.getView.mock.calls.at(-1)).toEqual([undefined, { elapsedMs: 12000 }]);
      expect(result.current.state.status).toBe("ready");
    } finally {
      clock.mockRestore();
    }
  });

  it("ML4/ML5: deadline error withdraws stale ready and requires explicit retry", async () => {
    const fake = host();
    const { result } = renderHook(() => useModelSelectionServiceView(fake.service));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    fake.getView.mockRejectedValueOnce(new Error("nek model read deadline exceeded at queue"));
    act(() => fake.invalidate());
    expect(result.current.state.status).toBe("loading");
    await waitFor(() => expect(result.current.state.status).toBe("error"));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
  });

  it("MW-U4: subscription admission failure is visible and retryable, not an effect crash", async () => {
    const fake = host();
    const subscribe = fake.service.onDynamicDidChange;
    fake.service.onDynamicDidChange = () => {
      throw new Error("watch capacity exceeded");
    };
    const { result } = renderHook(() => useModelSelectionServiceView(fake.service));
    await waitFor(() => expect(result.current.state.status).toBe("error"));
    expect(fake.getView).not.toHaveBeenCalled();
    fake.service.onDynamicDidChange = subscribe;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
  });

  it("MW-U1: workspace lease is stable across renders, replaced on switch and released on unmount", async () => {
    const fake = host();
    const { result, rerender, unmount } = renderHook(
      ({ path }) =>
        useModelSelectionServiceView(fake.service, true, "remote-waiting", {
          selection: null,
          workspacePath: path,
        }),
      { initialProps: { path: "/a" } },
    );
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect([...fake.listeners.values()]).toEqual(["/a"]);
    rerender({ path: "/a" });
    expect(fake.getView).toHaveBeenCalledTimes(1);
    rerender({ path: "/b" });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect([...fake.listeners.values()]).toEqual(["/b"]);
    unmount();
    expect(fake.listeners.size).toBe(0);
  });

  it("MW-U2: invalidation immediately withdraws ready; stale success cannot overwrite current failure", async () => {
    const fake = host();
    const { result } = renderHook(() => useModelSelectionServiceView(fake.service));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    const older = deferred();
    const newer = deferred();
    fake.getView
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);
    act(() => fake.invalidate());
    expect(result.current.state.status).toBe("loading");
    act(() => fake.invalidate());
    expect(fake.getView).toHaveBeenCalledTimes(2);
    await act(async () => older.resolve(VIEW));
    expect(result.current.state.status).toBe("loading");
    await act(async () => newer.reject(new Error("reload rejected")));
    expect(result.current.state.status).toBe("error");
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
  });

  it("MW-U3: switching targets rejects a late result from the previous service", async () => {
    const first = host();
    const second = host();
    const old = deferred();
    first.getView.mockImplementationOnce(() => old.promise);
    const { result, rerender } = renderHook(
      ({ service }) => useModelSelectionServiceView(service),
      { initialProps: { service: first.service } },
    );
    rerender({ service: second.service });
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    await act(async () => old.reject(new Error("old remote disconnected")));
    expect(result.current.state.status).toBe("ready");
    expect(first.listeners.size).toBe(0);
  });
});
