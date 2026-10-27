/**
 * 设置中心在 `INekConfigApi` 之外需要的 GUI 侧能力（远程主机管理、打开目录、更新与诊断）。
 *
 * 这些能力属于 GUI 自身（主机列表、指纹存储、日志），不经过 nek 配置文件，
 * 因此不放进共享契约；真实实现由 desktop/host 注入，开发与测试使用 `mockHostApi`。
 * 报告里给出了把它们并入共享契约的建议。
 */
import type { RemoteTarget } from "@zcode/shared";
import type { NekConfigTarget, NekConfigTargetInfo } from "@zcode/shared/nek-protocol";

export type NekHostAuthMethod = "agent" | "privateKey" | "password";

export interface NekHostFingerprint {
  /** `SHA256:...` */
  fingerprint: string;
  keyType: string;
  /** epoch ms */
  addedAt: number;
}

export interface NekRemoteHost {
  /** 与 `NekConfigTarget.connectionId` 一致。 */
  connectionId: string;
  alias: string;
  /** 已去掉密码等 secret。 */
  target: RemoteTarget;
  authMethod: NekHostAuthMethod;
  fingerprints: NekHostFingerprint[];
  state: "connected" | "connecting" | "disconnected" | "failed";
  error?: string;
  nek: NekConfigTargetInfo["nek"];
}

export type NekHostTestResult =
  | { ok: true; latencyMs: number; fingerprint: string }
  | { ok: false; message: string };

export interface NekInstallOptions {
  channel?: "stable" | "dev";
  repoUrl?: string;
  nodeMirror?: string;
}

export type NekInstallResult =
  | { ok: true; version: string }
  | { ok: false; message: string; manualCommand: string };

export interface NekUpdateCheck {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export interface NekAppInfo {
  guiVersion: string;
  platform: string;
  logsDir: string;
}

export interface INekSettingsHostApi {
  // ---- 远程主机 ----
  listHosts(): Promise<NekRemoteHost[]>;
  saveHost(input: {
    connectionId?: string;
    alias: string;
    target: RemoteTarget;
  }): Promise<NekRemoteHost>;
  deleteHost(connectionId: string): Promise<void>;
  connectHost(connectionId: string): Promise<void>;
  disconnectHost(connectionId: string): Promise<void>;
  testHost(connectionId: string): Promise<NekHostTestResult>;
  installNek(
    connectionId: string,
    options: NekInstallOptions,
    onLog: (line: string) => void,
  ): Promise<NekInstallResult>;
  removeFingerprint(connectionId: string, fingerprint: string): Promise<void>;
  /** 主机列表或连接状态变化。 */
  onHostsChanged(listener: () => void): () => void;

  // ---- 系统 ----
  /** 在系统文件管理器中打开目录；远程目标不支持时抛错。 */
  openPath(target: NekConfigTarget, path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;

  // ---- 关于 ----
  getAppInfo(): Promise<NekAppInfo>;
  checkNekUpdate(target: NekConfigTarget): Promise<NekUpdateCheck>;
  runNekUpdate(
    target: NekConfigTarget,
    onLog: (line: string) => void,
  ): Promise<{ version: string }>;
  exportDiagnostics(): Promise<{ path: string; sizeBytes: number }>;
  openLogsDirectory(): Promise<void>;
}
