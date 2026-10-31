// @vitest-environment happy-dom
/**
 * 草稿模型门禁：事实只有一份（目标 Host 的 ModelSelectionService.getView）。
 *
 * 覆盖：nek 有模型 → 放行；没有模型 → 可见的配置需求并拦住首发；读取失败 → 可见的
 * 可重试错误（不伪装成空表、不静默放行）；已存在的会话不参与门禁。
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import type { IModelSelectionService, ModelSelectionView } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { useDraftModelReadinessGate } from "./useDraftModelReadinessGate.js";

const EMPTY_VIEW: ModelSelectionView = { revision: 1, providers: [] };
/** 模型被删掉后再读到的空目录；revision 必须比旧 View 新。 */
const EMPTY_VIEW_LATER: ModelSelectionView = { revision: 3, providers: [] };
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
          supportsImage: false,
        },
      ],
    },
  ],
};

function serviceOf(view: ModelSelectionView): IModelSelectionService {
  return {
    getView: vi.fn(async () => view),
    onDidChange: vi.fn(() => ({ dispose: () => undefined })),
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
    const service = serviceOf(READY_VIEW);
    const { result } = renderGate(service);
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
    expect(result.current.error).toBeNull();
    await expect(result.current.ensureReadyForSend()).resolves.toBe(true);
  });

  it("没有可用模型时显示配置需求并拦住首发", async () => {
    const service = serviceOf(EMPTY_VIEW);
    const { result } = renderGate(service);
    await waitFor(() => expect(result.current.error?.code).toBe("model_config_missing"));
    expect(result.current.agentStartupAllowed).toBe(false);
    await expect(result.current.ensureReadyForSend()).resolves.toBe(false);
  });

  it("读取失败时显示可重试错误，不伪装成空表也不放行", async () => {
    const failure = new Error("agents dir is not readable (EACCES)");
    const getView = vi.fn(async () => {
      throw failure;
    });
    const service: IModelSelectionService = {
      getView,
      onDidChange: vi.fn(() => ({ dispose: () => undefined })),
    };
    const { result } = renderGate(service);
    await waitFor(() => expect(result.current.error?.code).toBe("model_config_unreadable"));
    expect(result.current.error?.detail).toContain("EACCES");
    expect(result.current.agentStartupAllowed).toBe(false);
    await expect(result.current.ensureReadyForSend()).resolves.toBe(false);

    act(() => result.current.retry());
    await waitFor(() => expect(getView.mock.calls.length).toBeGreaterThan(1));
  });

  it("首发复查得到空目录时重新显示配置需求", async () => {
    const service = serviceOf(READY_VIEW);
    const { result } = renderGate(service);
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));

    vi.mocked(service.getView).mockResolvedValue(EMPTY_VIEW_LATER);
    await expect(result.current.ensureReadyForSend()).resolves.toBe(false);
    await waitFor(() => expect(result.current.error?.code).toBe("model_config_missing"));
  });

  it("已存在的会话不参与门禁（模型事实只约束草稿首发）", async () => {
    const service = serviceOf(EMPTY_VIEW);
    const { result } = renderGate(service, "session-1");
    expect(result.current.agentStartupAllowed).toBe(true);
    expect(result.current.error).toBeNull();
    await expect(result.current.ensureReadyForSend()).resolves.toBe(true);
    expect(service.getView).not.toHaveBeenCalled();
  });

  it("Host 门禁竞态命中时把同一裁决投影成配置需求横幅，不静默消失", async () => {
    const service = serviceOf(READY_VIEW);
    const { result } = renderGate(service);
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
    act(() => result.current.markProviderNotReady());
    // 事实暂时没变也要保留原因：横幅不因“View 里还有模型”而消失。
    await waitFor(() => expect(result.current.error?.code).toBe("model_config_missing"));
    expect(result.current.agentStartupAllowed).toBe(false);
  });
});
