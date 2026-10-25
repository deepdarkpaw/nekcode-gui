/**
 * 设置中心测试工具：intl + tooltip + NekSettingsProvider（零延迟 mock）。
 * 只给 `*.test.tsx` 使用。
 */
import type { ReactNode } from "react";
import { act } from "@testing-library/react";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { MockNekConfigApi } from "../api/mock/mockNekConfigApi.js";
import { MockNekSettingsHostApi } from "../api/mock/mockHostApi.js";
import {
  LOCAL_TARGET,
  NekSettingsProvider,
  useNekTargetSelection,
} from "../api/NekSettingsContext.js";
import { MOCK_PROJECT_CWD } from "../api/mock/mockSeed.js";

export interface NekTestEnv {
  config: MockNekConfigApi;
  host: MockNekSettingsHostApi;
  wrapper: (props: { children: ReactNode }) => ReactNode;
}

export function createNekTestEnv(
  options: { projectCwd?: string | null; latencyMs?: number } = {},
): NekTestEnv {
  const config = new MockNekConfigApi({
    latencyMs: options.latencyMs ?? 0,
    loginStepMs: 5,
    deviceAutoCompleteMs: 60_000,
  });
  const host = new MockNekSettingsHostApi(config, 0);
  const projectCwd =
    options.projectCwd === null ? undefined : (options.projectCwd ?? MOCK_PROJECT_CWD);
  useNekTargetSelection.setState({ target: LOCAL_TARGET });
  const apis = { config, host, isMock: true };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <NekSettingsProvider apis={apis} projectCwd={projectCwd}>
          {children}
        </NekSettingsProvider>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
  return { config, host, wrapper };
}

/** 让 mock 的 setTimeout(0) watch 事件与后续 Promise 全部落地。 */
export async function flushNek(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** happy-dom 缺失的浏览器 API（Radix 依赖）。 */
export function installDomPolyfills(): void {
  const proto = globalThis.HTMLElement?.prototype as unknown as Record<string, unknown> | undefined;
  if (proto && !proto.scrollIntoView) {
    proto.scrollIntoView = () => undefined;
  }
  if (proto && !proto.hasPointerCapture) {
    proto.hasPointerCapture = () => false;
    proto.releasePointerCapture = () => undefined;
  }
  // happy-dom 的 WAAPI 在元素卸载时以 AbortError 拒绝 animation.finished；
  // 去掉 animate 让 motion 退回 JS 动画，避免测试里出现未处理的拒绝。
  const elementProto = globalThis.Element?.prototype as unknown as
    | Record<string, unknown>
    | undefined;
  if (elementProto && "animate" in elementProto) {
    delete elementProto.animate;
  }
  const globals = globalThis as unknown as Record<string, unknown>;
  if (!globals.ResizeObserver) {
    globals.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
}
