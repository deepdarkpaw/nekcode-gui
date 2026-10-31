// @vitest-environment happy-dom
/**
 * 草稿模型门禁回归：nek build 的模型事实在 nek 侧（models.json / settings.json），
 * GUI provider registry 为空时不能直接把首发拦下。
 */
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren, ReactElement } from "react";
import type { IServiceAccessor, ModelSelectionView } from "@zcode/services";
import { describe, expect, it, vi } from "vitest";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useDraftModelReadinessGate } from "./useDraftModelReadinessGate.js";

const EMPTY_VIEW: ModelSelectionView = { revision: 1, providers: [] };
const READY_VIEW: ModelSelectionView = {
  revision: 2,
  providers: [
    {
      providerId: "mock",
      models: [{ modelId: "mock-model", config: {} }],
    },
  ],
} as unknown as ModelSelectionView;

function modelSelectionService(view: ModelSelectionView) {
  return {
    getView: vi.fn(async () => view),
    onDidChange: vi.fn(() => ({ dispose: () => undefined })),
  };
}

function serviceWrapper(agentService: unknown): (props: PropsWithChildren) => ReactElement {
  const services = { zcodeAgentService: agentService } as unknown as IServiceAccessor;
  return ({ children }) => <ServiceProvider services={services}>{children}</ServiceProvider>;
}

function renderGate(
  view: ModelSelectionView,
  agentService: unknown,
  options: { wrapper?: (props: PropsWithChildren) => ReactElement } = {},
) {
  // service 必须跨渲染稳定：每次 render 新建对象会让 gate 的 effect 反复重跑。
  const stableService = modelSelectionService(view);
  return renderHook(
    () =>
      useDraftModelReadinessGate({
        workspacePath: "/workspace",
        sessionId: null,
        modelSelectionService: stableService,
      }),
    options.wrapper ? { wrapper: options.wrapper } : {},
  );
}

describe("useDraftModelReadinessGate", () => {
  it("GUI registry 为空但 nek 有可用模型时放行", async () => {
    const agentService = {
      getModelProviderAvailability: vi.fn(async () => ({
        available: true,
        providerCount: 1,
        modelCount: 2,
      })),
    };
    const { result } = renderGate(EMPTY_VIEW, agentService, {
      wrapper: serviceWrapper(agentService),
    });

    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
    expect(result.current.error).toBeNull();
    await expect(result.current.ensureReadyForSend()).resolves.toBe(true);
  });

  it("nek 也没有模型时仍然拦住首发", async () => {
    const agentService = {
      getModelProviderAvailability: vi.fn(async () => ({
        available: false,
        providerCount: 0,
        modelCount: 0,
      })),
    };
    const { result } = renderGate(EMPTY_VIEW, agentService, {
      wrapper: serviceWrapper(agentService),
    });

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.agentStartupAllowed).toBe(false);
    await expect(result.current.ensureReadyForSend()).resolves.toBe(false);
  });

  it("没有 agent service 时保持 registry 判定（旧行为）", async () => {
    const { result } = renderGate(EMPTY_VIEW, undefined);
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(false));
    expect(result.current.error?.code).toBe("model_config_missing");
  });

  it("registry 有模型时无需询问 agent", async () => {
    const agentService = {
      getModelProviderAvailability: vi.fn(async () => ({
        available: false,
        providerCount: 0,
        modelCount: 0,
      })),
    };
    const { result } = renderGate(READY_VIEW, agentService, {
      wrapper: serviceWrapper(agentService),
    });
    await waitFor(() => expect(result.current.agentStartupAllowed).toBe(true));
    expect(agentService.getModelProviderAvailability).not.toHaveBeenCalled();
  });
});
