/**
 * 设置中心 host 能力的共享契约适配入口。
 *
 * 具体实现由 desktop/host 注入，renderer 与 mock 只依赖 `@zcode/shared/nek-protocol` 的同一份类型。
 */
import type {
  INekSettingsHostApi,
  NekAppInfo,
  NekHostFingerprint,
  NekHostTestResult,
  NekInstallOptions,
  NekInstallResult,
  NekRemoteHost,
  NekUpdateCheck,
} from "@zcode/shared/nek-protocol";

export type {
  INekSettingsHostApi,
  NekAppInfo,
  NekHostFingerprint,
  NekHostTestResult,
  NekInstallOptions,
  NekInstallResult,
  NekRemoteHost,
  NekUpdateCheck,
};
