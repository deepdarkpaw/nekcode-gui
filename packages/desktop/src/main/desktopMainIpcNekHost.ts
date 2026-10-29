import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
import { NekLocator, NekLocatorError } from "../../../services/src/nek-agent/nekLocator.js";
import {
  buildNekInstallCommand,
  createRemoteBackend,
  detectRemoteNek,
  installRemoteNek,
  type IRemoteBackend,
} from "@zcode/server/remote";

interface StoredHost {
  connectionId: string;
  alias: string;
  target: NekRemoteHost["target"];
  fingerprints: NekRemoteHost["fingerprints"];
}

type HostListener = () => void;
type LogListener = (line: string) => void;

const GUI_DIR = join(homedir(), ".nek", "gui");
const HOSTS_PATH = join(GUI_DIR, "hosts.json");
const ONBOARDING_PATH = join(GUI_DIR, "onboarding.json");
const MAX_LOG_BYTES = 64 * 1024;

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function mapInstallResult(result: {
  ok: boolean;
  cancelled: boolean;
  stderrSummary: string;
  exitCode: number | null;
  manualCommand?: string;
}): NekInstallResult {
  if (result.ok) {
    return { ok: true, version: "unknown" };
  }
  return {
    ok: false,
    cancelled: result.cancelled,
    message: result.stderrSummary || `installer exited with ${result.exitCode ?? "no code"}`,
    manualCommand: result.manualCommand ?? "",
  };
}

function appendLines(buffer: { value: string }, chunk: Buffer | string, onLog: LogListener): void {
  buffer.value = `${buffer.value}${chunk.toString()}`.slice(-MAX_LOG_BYTES);
  const lines = buffer.value.split(/\r?\n/u);
  buffer.value = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim()) onLog(line);
  }
}

async function runLocalCommand(
  command: string,
  args: string[],
  signal: AbortSignal,
  onLog: LogListener,
): Promise<{ code: number | null; cancelled: boolean; output: string }> {
  const child = spawn(command, args, {
    cwd: homedir(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { value: "" };
  const abort = () => child.kill("SIGINT");
  signal.addEventListener("abort", abort, { once: true });
  child.stdout.on("data", (chunk: Buffer | string) => appendLines(output, chunk, onLog));
  child.stderr.on("data", (chunk: Buffer | string) => appendLines(output, chunk, onLog));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  signal.removeEventListener("abort", abort);
  if (output.value.trim()) onLog(output.value);
  return { code, cancelled: signal.aborted, output: output.value };
}

export class NekSettingsHostService implements INekSettingsHostApi {
  private readonly hostListeners = new Set<HostListener>();
  private readonly localInstallControllers = new Set<AbortController>();
  private readonly remoteInstallControllers = new Map<
    string,
    { controller: AbortController; backend: IRemoteBackend }
  >();
  private hosts: StoredHost[] | undefined;

  constructor(private readonly locator = new NekLocator()) {}

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
      fingerprints: current?.fingerprints ?? [],
    };
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
    await this.persistHosts(next);
    this.emitHostsChanged();
  }

  async connectHost(connectionId: string): Promise<void> {
    const host = await this.requireHost(connectionId);
    const result = await this.testHost(connectionId);
    if (!result.ok) throw new Error(result.message);
    host.fingerprints = host.fingerprints.some((item) => item.fingerprint === result.fingerprint)
      ? host.fingerprints
      : [
          ...host.fingerprints,
          { fingerprint: result.fingerprint, keyType: "unknown", addedAt: Date.now() },
        ];
    await this.persistHosts(await this.readHosts());
    this.emitHostsChanged();
  }

  async disconnectHost(connectionId: string): Promise<void> {
    await this.requireHost(connectionId);
    this.emitHostsChanged();
  }

  async testHost(connectionId: string): Promise<NekHostTestResult> {
    const host = await this.requireHost(connectionId);
    const startedAt = Date.now();
    let backend: IRemoteBackend | undefined;
    try {
      backend = await createRemoteBackend(host.target);
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
    const backend = await createRemoteBackend(host.target);
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
    await shell.openExternal(url);
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
      const command = buildNekInstallCommand(options);
      const shellCommand = process.platform === "win32" ? "bash" : "sh";
      const result = await runLocalCommand(
        shellCommand,
        ["-lc", command],
        controller.signal,
        onLog,
      );
      if (result.code === 0 && !result.cancelled) {
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
    const command = process.platform === "win32" ? "nek.cmd" : "nek";
    const result = await runLocalCommand(command, ["update"], controller.signal, onLog);
    if (result.code !== 0)
      throw new Error(result.output || `nek update exited with ${result.code ?? "no code"}`);
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

  private async readHosts(): Promise<StoredHost[]> {
    this.hosts ??= await readJson(HOSTS_PATH, []);
    return this.hosts;
  }

  private async persistHosts(hosts: StoredHost[]): Promise<void> {
    this.hosts = hosts;
    await writeJsonAtomic(HOSTS_PATH, hosts);
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
      authMethod: "agent",
      fingerprints: host.fingerprints,
      state: "disconnected",
      nek: { state: "unknown" },
    };
  }

  private emitHostsChanged(): void {
    for (const listener of this.hostListeners) listener();
  }
}
