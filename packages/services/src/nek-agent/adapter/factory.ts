import { NekLocator } from "../nekLocator.js";
import { NekAgentServiceAdapter } from "./nekAgentServiceAdapter.js";
import type { NekAgentServiceAdapterOptions } from "./types.js";
import { createNekRpcProcess } from "../nekRpcProcess.js";

/**
 * 生产装配工厂：定位 nek 延迟到第一次控制/会话进程启动，避免 host 启动时阻塞 GUI。
 * 测试可注入 `guiInfo` 或 process factories，不会调用真实模型 API。
 */
export function createNekAgentServiceAdapter(
  options: NekAgentServiceAdapterOptions & { locator?: NekLocator },
): NekAgentServiceAdapter {
  const { locator, ...serviceOptions } = options;
  let infoPromise = serviceOptions.guiInfo
    ? Promise.resolve(serviceOptions.guiInfo)
    : undefined;
  const locate = async () => {
    infoPromise ??= (locator ?? new NekLocator()).locate().then((result) => result.info);
    return await infoPromise;
  };
  return new NekAgentServiceAdapter({
    ...serviceOptions,
    createControlProcess:
      serviceOptions.createControlProcess ??
      (async () =>
        createNekRpcProcess({
          guiInfo: await locate(),
          cwd: serviceOptions.cwd ?? process.cwd(),
          control: true,
        })),
    createSessionProcess:
      serviceOptions.createSessionProcess ??
      (async (request) =>
        createNekRpcProcess({
          guiInfo: await locate(),
          cwd: request.cwd,
          sessionPath: request.sessionPath,
          approve: request.approve,
          client: request.extensionUi ? { extensionUi: request.extensionUi } : undefined,
        })),
  });
}
