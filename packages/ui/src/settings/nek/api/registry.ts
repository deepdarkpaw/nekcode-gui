/**
 * 设置中心 API 注入点：真实实现由 host 侧（desktop preload / services）在启动时注册；
 * 未注册时使用内存 mock，并在界面上显式标注"模拟数据"，不冒充真实配置。
 */
import type { INekConfigApi } from "@zcode/shared/nek-protocol";
import type { INekSettingsHostApi } from "./hostApi.js";
import type { NekSettingsApis } from "./NekSettingsContext.js";
import { MockNekSettingsHostApi } from "./mock/mockHostApi.js";
import { MockNekConfigApi } from "./mock/mockNekConfigApi.js";

let registered: NekSettingsApis | null = null;
let mockApis: NekSettingsApis | null = null;

export function registerNekSettingsApis(config: INekConfigApi, host: INekSettingsHostApi): void {
  registered = { config, host, isMock: false };
}

export function createMockNekSettingsApis(
  latencyMs = 150,
): NekSettingsApis & { config: MockNekConfigApi } {
  const config = new MockNekConfigApi({ latencyMs });
  return { config, host: new MockNekSettingsHostApi(config, latencyMs), isMock: true };
}

/** 已注册的真实实现；没有时返回（同一个）mock 实例。 */
export function resolveNekSettingsApis(): NekSettingsApis {
  if (registered) {
    return registered;
  }
  mockApis ??= createMockNekSettingsApis();
  return mockApis;
}
