// @vitest-environment happy-dom
/**
 * 草稿模型门禁：事实只有一份（目标 Host 的 ModelSelectionService.getView），
 * 状态只经 getView 的 ready/missing/error 表达。
 *
 * 覆盖：nek 有模型 → 放行；没有模型 → 可见的配置需求并拦住首发；读取失败 → 可见的可重试
 * 错误；关掉横幅只改展示，不解除 blocking；失效信号会触发重读；已存在的会话不参与门禁。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { useDraftModelReadinessGate } from "./useDraftModelReadinessGate.js";

const EMPTY_VIEW: ModelSelectionView = { revision: 1, providers: [] };
const READY_VIEW: ModelSelectionView = {
  revision: 2,
  providers: [
    {
      providerId: "mock",
      displayName: "Mock Provider",
      models: [
        {
          modelId: "mock-model",
          displayName: "Local Mock Model",
          reasoningLevels: ["off"],
          defaultReasoningLevel: "off",
          supportsImage: false,
        },
      ],
    },
  ],
};
const MISSING_DEFAULT_VIEW: ModelSelectionView = {
  ...READY_VIEW,
  preferredSelectionIssue: "configured-default-unavailable",
};

/** 可控的 Host service 替身：失效信号是 `Event<void>`，所有读取都经过 `getView`。 */
function createHostService(initial: ModelSelectionView) {
  const listeners = new Set<() => void>();
  let next = initial;
  const getView = vi.fn(async () => next);
  const service: IModelSelectionService = {
    getView,
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    service,
    getView,
    setView(view: ModelSelectionView) {
      next = view;
    },
    /** 推一次失效信号（配置变化），消费者应重新 getView。 */
    invalidate() {
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function renderGate(service: IModelSelectionService | null, sessionId: string | null = null) {
  return renderHook(() =>
    useDraftModelReadinessGate({
      workspacePath: "/workspace",
      sessionId,
      modelSelectionService: service,
    }),
  );
}

describe("useDraftModelReadinessGate", () => {
  it("nek 有可用模型时放行首发", async () => {
    const host = createHostService(READY_VIEW);
    const { result } = renderGate(host.service);
    await waitFor(() => expect(result.current.error).toBeNull());
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
    await expect(result.current.ensureReadyForSend()).resolves.toBe(true);
  });

  it("没有可用模型时显示配置需求并拦住首发", async () => {
    const host = createHostService(EMPTY_VIEW);
    const { result } = renderGate(host.service);
    await waitFor(() => expect(result.current.error?.code).toBe("model_config_missing"));
    expect(result.current.agentStartupAllowed).toBe(false);
    await expect(result.current.ensureReadyForSend()).resolves.toBe(false);
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(false));
  });

  it("读取失败时显示可重试错误，不伪装成空表也不放行", async () => {
    const failure = new Error("agents dir is not readable (EACCES)");
    const listeners = new Set<() => void>();
    const getView = vi.fn(async () => {
      throw failure;
    });
    const service: IModelSelectionService = {
      getView,
      onDidChange: (listener) => {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    };
    const { result } = renderGate(service);
    await waitFor(() => expect(result.current.error?.code).toBe("model_config_unreadable"));
    await waitFor(() => expect(result.current.error?.detail).toContain("EACCES"));
    expect(result.current.agentStartupAllowed).toBe(false);
    await expect(result.current.ensureReadyForSend()).resolves.toBe(false);

    act(() => result.current.retry());
    await waitFor(() => expect(getView.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(false));
  });

  it("关掉横幅只改展示：被拦住的首发仍然被拦住", async () => {
    const host = createHostService(EMPTY_VIEW);
    const { result } = renderGate(host.service);
    await waitFor(() => expect(result.current.error?.code).toBe("model_config_missing"));

    act(() => result.current.dismissError());
    await waitFor(() => expect(result.current.error).toBeNull());
    // 关键：横幅消失不等于放行。
    expect(result.current.agentStartupAllowed).toBe(false);
    await expect(result.current.ensureReadyForSend()).resolves.toBe(false);
    await waitFor(() => expect(result.current.error?.code).toBe("model_config_missing"));
  });

  it("Host 门禁竞态命中后，关掉横幅也不解除 blocking，直到事实变化", async () => {
    const host = createHostService(READY_VIEW);
    const { result } = renderGate(host.service);
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));

    act(() => result.current.markProviderNotReady());
    await waitFor(() => expect(result.current.error?.code).toBe("model_config_missing"));
    expect(result.current.agentStartupAllowed).toBe(false);

    act(() => result.current.dismissError());
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.agentStartupAllowed).toBe(false);

    // 事实变化（配置修好/换了模型）才重新裁决。
    const recovered: ModelSelectionView = { ...READY_VIEW, revision: 3 };
    host.setView(recovered);
    act(() => {
      host.invalidate();
    });
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
  });

  it("失效信号触发重读：空目录 → 配置改好后自动放行", async () => {
    const host = createHostService(EMPTY_VIEW);
    const { result } = renderGate(host.service);
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(false));

    host.setView(READY_VIEW);
    act(() => {
      host.invalidate();
    });
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
    expect(result.current.error).toBeNull();
  });

  it("配置的默认模型不可用时，模型菜单仍可用（门禁只回答“有没有模型”）", async () => {
    const host = createHostService(MISSING_DEFAULT_VIEW);
    const { result } = renderGate(host.service);
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
    // 重选由 Composer 的空选择 + 菜单承担，门禁不把“默认不可用”误报成没有模型。
    expect(result.current.error).toBeNull();
  });

  it("已存在的会话不参与门禁", async () => {
    const host = createHostService(EMPTY_VIEW);
    const { result } = renderGate(host.service, "session-1");
    expect(result.current.agentStartupAllowed).toBe(true);
    expect(result.current.error).toBeNull();
    await expect(result.current.ensureReadyForSend()).resolves.toBe(true);
    expect(host.getView).not.toHaveBeenCalled();
  });

  it("卸载时释放订阅", async () => {
    const host = createHostService(READY_VIEW);
    const { unmount } = renderGate(host.service);
    await waitFor(() => expect(host.listenerCount()).toBe(1));
    unmount();
    await waitFor(() => expect(host.listenerCount()).toBe(0));
  });
});
