import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { app, clipboard, dialog, shell } from "electron";
import type {
  INekSettingsHostApi,
  NekAppInfo,
  NekConfigTarget,
  NekHostTestResult,
  NekInstallOptions,
  NekInstallResult,
  NekLocalDetection,
  NekOnboardingState,
  NekRemoteHost,
  NekRemoteHost as NekRemoteHostRecord,
  NekUpdateCheck,
} from "@zcode/shared/nek-protocol";
import { stripRemoteTargetSecrets } from "@zcode/shared";
import { NEK_GUI_PROTOCOL_VERSION } from "@zcode/shared/nek-protocol";
import {
  NekLocator,
  NekLocatorError,
  toLocatorCommand,
} from "../../../services/src/nek-agent/nekLocator.js";
import {
  createRemoteBackend,
  detectRemoteNek,
  installRemoteNek,
  type IRemoteBackend,
} from "@zcode/server/remote";
import type { NekConfigHostExecutor } from "../../../services/src/nek-config-api/hostExecutor.js";
import type { NekLoginPortForward } from "../../../services/src/nek-config-api/runtime.js";
import { NekRemoteConfigConnectionRegistry } from "./desktopMainIpcNekConfig.js";
import type { RemoteCredentialSafeStorage } from "./remoteCredentialSafeStorage.js";
import { desktopRemoteCredentialStore } from "./desktopCredentialBridge.js";
import { SavedRemoteHostCredentials, savedHostAuthMethod } from "./savedRemoteHostCredentials.js";
import {
  localInstallInvocation,
  mapInstallResult,
  runLocalCommand,
  type LogListener,
} from "./desktopLocalNekInstall.js";

interface StoredHost {
  connectionId: string;
  alias: string;
  target: NekRemoteHost["target"];
  authMethod?: NekRemoteHost["authMethod"];
  fingerprints: NekRemoteHost["fingerprints"];
}

type HostListener = () => void;

const GUI_DIR = join(homedir(), ".nek", "gui");
const HOSTS_PATH = join(GUI_DIR, "hosts.json");
const ONBOARDING_PATH = join(GUI_DIR, "onboarding.json");
function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 与 nek 登录对话框同一规则（`trustedHttpUrl`）：链接来自服务端，只打开 HTTP(S)，
 * 绝不启动本地文件或自定义协议处理器。
 */
export function trustedHttpUrl(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

interface NekSettingsHostServiceOptions {
  locator?: NekLocator;
  credentialStore?: Pick<
    RemoteCredentialSafeStorage,
    "setCredential" | "getCredential" | "deleteCredential"
  >;
  remoteConfigs?: NekRemoteConfigConnectionRegistry;
  hostsPath?: string;
}

export class NekSettingsHostService implements INekSettingsHostApi {
  private readonly hostListeners = new Set<HostListener>();
  private readonly localInstallControllers = new Set<AbortController>();
  private readonly remoteInstallControllers = new Map<
    string,
    { controller: AbortController; backend: IRemoteBackend }
  >();
  private readonly remoteConfigs: NekRemoteConfigConnectionRegistry;
  private readonly credentials: SavedRemoteHostCredentials;
  private readonly hostsPath: string;
  private hosts: StoredHost[] | undefined;

  constructor(options: NekSettingsHostServiceOptions = {}) {
    this.locator = options.locator ?? new NekLocator();
    this.credentials = new SavedRemoteHostCredentials(
      options.credentialStore ?? desktopRemoteCredentialStore,
    );
    this.remoteConfigs = options.remoteConfigs ?? new NekRemoteConfigConnectionRegistry();
    this.hostsPath = options.hostsPath ?? HOSTS_PATH;
  }

  private readonly locator: NekLocator;

  async listHosts(): Promise<NekRemoteHost[]> {
    const hosts = await this.readHosts();
    return hosts.map((host) => this.toRemoteHost(host));
  }

  async saveHost(input: {
    connectionId?: string;
    alias: string;
    target: NekRemoteHost["target"];
  }): Promise<NekRemoteHost> {
    const hosts = await this.readHosts();
    const connectionId = input.connectionId ?? randomUUID();
    const current = hosts.find((host) => host.connectionId === connectionId);
    const next: StoredHost = {
      connectionId,
      alias: input.alias.trim(),
      target: stripRemoteTargetSecrets(input.target),
      authMethod: savedHostAuthMethod(input.target),
      fingerprints: current?.fingerprints ?? [],
    };
    if (
      current &&
      input.target.kind === "ssh" &&
      !input.target.privateKeyPath &&
      input.target.password === undefined
    )
      next.authMethod = current.authMethod;
    await this.credentials.save(connectionId, input.target, current?.target);
    const index = hosts.findIndex((host) => host.connectionId === connectionId);
    if (index === -1) hosts.push(next);
    else hosts[index] = next;
    await this.persistHosts(hosts);
    this.emitHostsChanged();
    return this.toRemoteHost(next);
  }

  async deleteHost(connectionId: string): Promise<void> {
    const hosts = await this.readHosts();
    const next = hosts.filter((host) => host.connectionId !== connectionId);
    if (next.length === hosts.length) return;
    await this.disconnectRemote(connectionId);
    await this.credentials.delete(connectionId);
    await this.persistHosts(next);
    this.emitHostsChanged();
  }

  /** 建立配置读写用的远端连接；主机密钥由 SSH backend 的 known-hosts 存储负责，不伪造指纹。 */
  async connectHost(connectionId: string): Promise<void> {
    const host = await this.requireHost(connectionId);
    await this.remoteConfigs.connect(
      connectionId,
      await this.credentials.restore(host.connectionId, host.target),
    );
    this.emitHostsChanged();
  }

  async disconnectHost(connectionId: string): Promise<void> {
    await this.requireHost(connectionId);
    await this.disconnectRemote(connectionId);
    this.emitHostsChanged();
  }

  configExecutor(connectionId: string): NekConfigHostExecutor | undefined {
    return this.remoteConfigs.executor(connectionId);
  }

  forwardLoginPorts(target: NekConfigTarget, ports: number[]): Promise<NekLoginPortForward> {
    return this.remoteConfigs.forwardLoginPorts(target, ports);
  }

  dispose(): void {
    void this.remoteConfigs.dispose();
    for (const item of this.remoteInstallControllers.values()) void item.backend.dispose();
    this.remoteInstallControllers.clear();
    this.hostListeners.clear();
  }

  async testHost(connectionId: string): Promise<NekHostTestResult> {
    const host = await this.requireHost(connectionId);
    const startedAt = Date.now();
    let backend: IRemoteBackend | undefined;
    try {
      backend = await createRemoteBackend(
        await this.credentials.restore(host.connectionId, host.target),
      );
      const detected = await detectRemoteNek(backend);
      if (detected.status !== "ready")
        return { ok: false, message: detected.error ?? detected.status };
      return { ok: true, latencyMs: Math.max(0, Date.now() - startedAt), fingerprint: "unknown" };
    } catch (error) {
      return { ok: false, message: asErrorMessage(error) };
    } finally {
      backend?.dispose();
    }
  }

  async installNek(
    connectionId: string,
    options: NekInstallOptions,
    onLog: LogListener,
  ): Promise<NekInstallResult> {
    const host = await this.requireHost(connectionId);
    const backend = await createRemoteBackend(
      await this.credentials.restore(host.connectionId, host.target),
    );
    try {
      return mapInstallResult(await installRemoteNek(backend, { ...options, onLog }));
    } finally {
      backend.dispose();
    }
  }

  async cancelInstall(_connectionId: string): Promise<void> {
    // Remote installers are owned by the connection backend. A future reconnect can
    // replace that owner; cancellation is intentionally explicit in the host service.
  }

  async removeFingerprint(connectionId: string, fingerprint: string): Promise<void> {
    const hosts = await this.readHosts();
    const host = hosts.find((item) => item.connectionId === connectionId);
    if (!host) return;
    host.fingerprints = host.fingerprints.filter((item) => item.fingerprint !== fingerprint);
    await this.persistHosts(hosts);
    this.emitHostsChanged();
  }

  onHostsChanged(listener: HostListener): () => void {
    this.hostListeners.add(listener);
    return () => this.hostListeners.delete(listener);
  }

  async openPath(_target: NekConfigTarget, path: string): Promise<void> {
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  }

  async openExternal(url: string): Promise<void> {
    const target = trustedHttpUrl(url);
    if (!target) throw new Error(`refusing to open a non-HTTP(S) link: ${url}`);
    await shell.openExternal(target);
  }

  async copyText(text: string): Promise<void> {
    clipboard.writeText(text);
  }

  async getAppInfo(): Promise<NekAppInfo> {
    return {
      guiVersion: app.getVersion(),
      platform: process.platform,
      logsDir: app.getPath("logs"),
    };
  }

  async detectLocalNek(): Promise<NekLocalDetection> {
    try {
      const located = await this.locator.locate();
      if (located.info.protocolVersion === NEK_GUI_PROTOCOL_VERSION) {
        return {
          status: "ready",
          version: located.info.nekVersion,
          path: located.launcherPath,
          protocolVersion: located.info.protocolVersion,
        };
      }
      return {
        status: "incompatible",
        version: located.info.nekVersion,
        path: located.launcherPath,
        protocolVersion: located.info.protocolVersion,
        requiredProtocolVersion: NEK_GUI_PROTOCOL_VERSION,
      };
    } catch (error) {
      if (error instanceof NekLocatorError && error.code === "not_found")
        return { status: "not_installed" };
      if (error instanceof NekLocatorError && error.code === "incompatible") {
        return {
          status: "incompatible",
          version: "unknown",
          path: error.detail?.launcherPath ?? "",
          protocolVersion: error.detail?.actualProtocolVersion ?? -1,
          requiredProtocolVersion:
            error.detail?.expectedProtocolVersion ?? NEK_GUI_PROTOCOL_VERSION,
        };
      }
      return { status: "failed", message: asErrorMessage(error) };
    }
  }

  async installLocalNek(options: NekInstallOptions, onLog: LogListener): Promise<NekInstallResult> {
    const controller = new AbortController();
    this.localInstallControllers.add(controller);
    try {
      const invocation = localInstallInvocation(options);
      const command = invocation.manualCommand;
      const result = await runLocalCommand(
        invocation.file,
        invocation.args,
        controller.signal,
        onLog,
      );
      if (result.code === 0 && !result.cancelled) {
        this.locator.invalidate();
        const detected = await this.detectLocalNek();
        if (detected.status === "ready") return { ok: true, version: detected.version };
      }
      return mapInstallResult({
        ok: false,
        cancelled: result.cancelled,
        stderrSummary: result.output,
        exitCode: result.code,
        manualCommand: command,
      });
    } finally {
      this.localInstallControllers.delete(controller);
    }
  }

  async cancelLocalInstall(): Promise<void> {
    for (const controller of this.localInstallControllers) controller.abort();
  }

  async pickDirectory(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }

  async getOnboardingState(): Promise<NekOnboardingState> {
    return await readJson(ONBOARDING_PATH, {});
  }

  async setOnboardingState(patch: Partial<NekOnboardingState>): Promise<void> {
    const current = await this.getOnboardingState();
    await writeJsonAtomic(ONBOARDING_PATH, { ...current, ...patch });
  }

  async checkNekUpdate(_target: NekConfigTarget): Promise<NekUpdateCheck> {
    const detection = await this.detectLocalNek();
    if (detection.status !== "ready") throw new Error("nek is not ready");
    return { current: detection.version, latest: detection.version, updateAvailable: false };
  }

  async runNekUpdate(_target: NekConfigTarget, onLog: LogListener): Promise<{ version: string }> {
    const controller = new AbortController();
    // 用定位器找到的启动器：Windows 上 nek.cmd 不能直接 spawn（Node 拒绝无 shell 执行 .cmd），
    // 也不能假设它在 PATH 里（安装器写的 PATH 对已运行的 GUI 不生效）。
    const located = await this.locator.locate();
    const command = toLocatorCommand(located.launcherPath, ["update"], process.platform);
    const result = await runLocalCommand(command.file, command.args, controller.signal, onLog, {
      windowsVerbatimArguments: command.windowsVerbatimArguments,
    });
    if (result.code !== 0)
      throw new Error(result.output || `nek update exited with ${result.code ?? "no code"}`);
    // 更新通常不改启动器本身，按 mtime 的缓存会继续报旧版本，必须先失效。
    this.locator.invalidate();
    const detection = await this.detectLocalNek();
    if (detection.status !== "ready")
      throw new Error("nek update completed but nek is unavailable");
    return { version: detection.version };
  }

  async exportDiagnostics(): Promise<{ path: string; sizeBytes: number }> {
    const logsDir = app.getPath("logs");
    const info = await stat(logsDir).catch(() => undefined);
    return { path: logsDir, sizeBytes: info?.size ?? 0 };
  }

  async openLogsDirectory(): Promise<void> {
    await this.openPath({ kind: "local" }, app.getPath("logs"));
  }

  private async disconnectRemote(connectionId: string): Promise<void> {
    await this.remoteConfigs.disconnect(connectionId);
  }

  private async readHosts(): Promise<StoredHost[]> {
    this.hosts ??= await readJson(this.hostsPath, []);
    return this.hosts;
  }

  private async persistHosts(hosts: StoredHost[]): Promise<void> {
    this.hosts = hosts;
    await writeJsonAtomic(this.hostsPath, hosts);
  }

  private async requireHost(connectionId: string): Promise<StoredHost> {
    const host = (await this.readHosts()).find((item) => item.connectionId === connectionId);
    if (!host) throw new Error(`unknown remote host: ${connectionId}`);
    return host;
  }

  private toRemoteHost(host: StoredHost): NekRemoteHostRecord {
    return {
      connectionId: host.connectionId,
      alias: host.alias,
      target: host.target,
      authMethod: host.authMethod ?? savedHostAuthMethod(host.target),
      fingerprints: host.fingerprints,
      state: this.remoteConfigs.has(host.connectionId) ? "connected" : "disconnected",
      nek: this.remoteConfigs.has(host.connectionId)
        ? {
            state: "ready",
            version: this.remoteConfigs.nekVersion(host.connectionId) ?? "unknown",
            agentDir: this.remoteConfigs.executor(host.connectionId)?.agentDir() ?? "",
          }
        : { state: "unknown" },
    };
  }

  private emitHostsChanged(): void {
    for (const listener of this.hostListeners) listener();
  }
}
