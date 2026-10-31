import type { IZCodeAgentService } from "../../zcode-agent/zcodeAgent.js";
import { NekLocator } from "../nekLocator.js";
import { NekAgentServiceAdapter } from "./nekAgentServiceAdapter.js";
import type { NekAgentServiceAdapterOptions } from "./types.js";
import { readNekModelAvailability } from "./nekModelAvailability.js";
import { createNekRpcProcess } from "../nekRpcProcess.js";

/**
 * 生产装配工厂：定位 nek 延迟到第一次控制/会话进程启动，避免 host 启动时阻塞 GUI。
 * 测试可注入 `guiInfo` 或 process factories，不会调用真实模型 API。
 */
export function createNekAgentServiceAdapter(
  options: NekAgentServiceAdapterOptions & { locator?: NekLocator },
): NekAgentServiceAdapter {
  const { locator, ...serviceOptions } = options;
  let infoPromise = serviceOptions.guiInfo ? Promise.resolve(serviceOptions.guiInfo) : undefined;
  const locate = async () => {
    infoPromise ??= (locator ?? new NekLocator()).locate().then((result) => result.info);
    return await infoPromise;
  };
  return new NekAgentServiceAdapter({
    ...serviceOptions,
    // 模型事实与 nek 同源：只读已定位 agentDir 下的 models.json / settings.json。
    readModelAvailability:
      serviceOptions.readModelAvailability ??
      (async () => await readNekModelAvailability((await locate()).agentDir)),
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

/** 阶段 3 依赖注入使用的明确工厂名；旧 ZCode 工厂不再作为 nek 运行时入口。 */
export function createNekZCodeAgentService(
  options: NekAgentServiceAdapterOptions & { locator?: NekLocator },
): IZCodeAgentService {
  return createNekAgentServiceAdapter(options);
}
