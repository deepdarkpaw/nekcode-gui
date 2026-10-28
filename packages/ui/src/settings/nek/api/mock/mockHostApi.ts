/**
 * `INekSettingsHostApi` 的内存 mock：主机列表与 mock 配置 API 的远程目标保持一致。
 */
import type {
  NekConfigTarget,
  NekInstallOptions,
  NekLocalStatus,
} from "@zcode/shared/nek-protocol";
import type { INekSettingsHostApi, NekRemoteHost } from "../hostApi.js";
import type { MockNekConfigApi } from "./mockNekConfigApi.js";
import { MOCK_REMOTE_CONNECTED, MOCK_REMOTE_DISCONNECTED } from "./mockSeed.js";

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function seedHosts(): NekRemoteHost[] {
  return [
    {
      connectionId: MOCK_REMOTE_CONNECTED,
      alias: "dev-box",
      target: {
        kind: "ssh",
        host: "10.0.0.5",
        port: 22,
        username: "dev",
        sshConfigAlias: "dev-box",
      },
      authMethod: "agent",
      fingerprints: [
        {
          fingerprint: "SHA256:3f9Kq2v1x8ZcWm7nHq0yJpLr5TtUa4bE6dC2sR9oPk0",
          keyType: "ssh-ed25519",
          addedAt: Date.now() - 20 * 86400_000,
        },
      ],
      state: "connected",
      nek: { state: "ready", version: "0.4.0", agentDir: "/home/dev/.nek/agent" },
    },
    {
      connectionId: MOCK_REMOTE_DISCONNECTED,
      alias: "gpu-server",
      target: {
        kind: "ssh",
        host: "gpu.example.com",
        port: 2222,
        username: "root",
        privateKeyPath: "~/.ssh/id_ed25519",
      },
      authMethod: "privateKey",
      fingerprints: [
        {
          fingerprint: "SHA256:Zx81LmNq4aBc7dEf2gHi9jKl0MnOp3QrStUvWxYz5A1",
          keyType: "ecdsa-sha2-nistp256",
          addedAt: Date.now() - 3 * 86400_000,
        },
      ],
      state: "disconnected",
      nek: { state: "not_installed" },
    },
  ];
}

export class MockNekSettingsHostApi implements INekSettingsHostApi {
  hosts: NekRemoteHost[] = seedHosts();
  private readonly listeners = new Set<() => void>();
  /** 每台主机当前进行中的安装；`cancelInstall` 用它作废进行中的迭代。 */
  private readonly installs = new Map<string, symbol>();
  private localInstallToken: symbol | undefined;
  private seq = 0;
  onboardingComplete = false;
  localNek: NekLocalStatus = {
    state: "ready",
    path: "/home/me/.local/bin/nek",
    version: "0.4.0",
    protocolVersion: 1,
  };
  selectedDirectory: string | null = "/home/me/projects/nekcode-gui";

  constructor(
    private readonly config: MockNekConfigApi,
    private readonly latencyMs = 0,
  ) {}

  private changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private host(connectionId: string): NekRemoteHost {
    const host = this.hosts.find((item) => item.connectionId === connectionId);
    if (!host) {
      throw new Error(`Unknown host ${connectionId}`);
    }
    return host;
  }

  private update(connectionId: string, patch: Partial<NekRemoteHost>): void {
    this.hosts = this.hosts.map((host) =>
      host.connectionId === connectionId ? { ...host, ...patch } : host,
    );
    this.changed();
  }

  async listHosts() {
    await delay(this.latencyMs);
    return structuredClone(this.hosts);
  }

  async saveHost(input: Parameters<INekSettingsHostApi["saveHost"]>[0]) {
    await delay(this.latencyMs);
    const authMethod =
      input.target.kind === "ssh" && input.target.privateKeyPath ? "privateKey" : "password";
    if (input.connectionId) {
      this.update(input.connectionId, { alias: input.alias, target: input.target, authMethod });
      return this.host(input.connectionId);
    }
    this.seq += 1;
    const host: NekRemoteHost = {
      connectionId: `conn-new-${this.seq}`,
      alias: input.alias,
      target: input.target,
      authMethod,
      fingerprints: [],
      state: "disconnected",
      nek: { state: "unknown" },
    };
    this.hosts = [...this.hosts, host];
    this.changed();
    return host;
  }

  async deleteHost(connectionId: string) {
    await delay(this.latencyMs);
    this.hosts = this.hosts.filter((host) => host.connectionId !== connectionId);
    this.changed();
  }

  async connectHost(connectionId: string) {
    this.update(connectionId, { state: "connecting" });
    await delay(Math.max(this.latencyMs, 400));
    this.config.setConnected({ kind: "remote", connectionId }, true);
    this.update(connectionId, {
      state: "connected",
      nek: this.config.machines.get(`remote:${connectionId}`)?.info.nek ?? {
        state: "not_installed",
      },
    });
  }

  async disconnectHost(connectionId: string) {
    await delay(this.latencyMs);
    this.config.setConnected({ kind: "remote", connectionId }, false);
    this.update(connectionId, { state: "disconnected" });
  }

  async testHost(connectionId: string) {
    await delay(Math.max(this.latencyMs, 300));
    const host = this.host(connectionId);
    if (host.target.kind === "ssh" && host.target.host.includes("unreachable")) {
      return { ok: false as const, message: "connect ETIMEDOUT" };
    }
    return {
      ok: true as const,
      latencyMs: 86,
      fingerprint: host.fingerprints[0]?.fingerprint ?? "SHA256:new",
    };
  }

  async installNek(connectionId: string, _options: unknown, onLog: (line: string) => void) {
    const lines = [
      "Downloading install.sh",
      "Installing Node.js runtime",
      "Installing nek 0.4.0",
      "Done",
    ];
    const token = Symbol(connectionId);
    this.installs.set(connectionId, token);
    try {
      for (const line of lines) {
        await delay(Math.max(this.latencyMs, 200));
        if (this.installs.get(connectionId) !== token) {
          throw new Error("install cancelled");
        }
        onLog(line);
      }
      this.update(connectionId, {
        nek: { state: "ready", version: "0.4.0", agentDir: "~/.nek/agent" },
      });
      return { ok: true as const, version: "0.4.0" };
    } finally {
      if (this.installs.get(connectionId) === token) this.installs.delete(connectionId);
    }
  }

  async cancelInstall(connectionId: string) {
    this.installs.delete(connectionId);
  }

  async removeFingerprint(connectionId: string, fingerprint: string) {
    await delay(this.latencyMs);
    const host = this.host(connectionId);
    this.update(connectionId, {
      fingerprints: host.fingerprints.filter((item) => item.fingerprint !== fingerprint),
    });
  }

  onHostsChanged(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async openPath(target: NekConfigTarget, path: string) {
    await delay(this.latencyMs);
    if (target.kind === "remote") {
      throw new Error(`Cannot open remote path ${path} locally`);
    }
  }

  async openExternal(_url: string) {
    await delay(this.latencyMs);
  }

  async copyText(text: string) {
    await navigator.clipboard?.writeText(text);
  }

  async getAppInfo() {
    await delay(this.latencyMs);
    return { guiVersion: "0.1.0-dev", platform: "win32", logsDir: "~/.nek/gui/logs" };
  }

  async readOnboardingComplete() {
    await delay(this.latencyMs);
    return this.onboardingComplete;
  }

  async writeOnboardingComplete(completed: boolean) {
    await delay(this.latencyMs);
    this.onboardingComplete = completed;
  }

  async detectLocalNek() {
    await delay(this.latencyMs);
    return structuredClone(this.localNek);
  }

  async installLocalNek(_options: NekInstallOptions, onLog: (line: string) => void) {
    const lines = [
      "Downloading install.sh",
      "Installing Node.js runtime",
      "Installing nek 0.4.0",
      "Done",
    ];
    const token = Symbol("local-install");
    this.localInstallToken = token;
    try {
      for (const line of lines) {
        await delay(Math.max(this.latencyMs, 200));
        if (this.localInstallToken !== token) {
          throw new Error("install cancelled");
        }
        onLog(line);
      }
      this.localNek = {
        state: "ready",
        path: "/home/me/.local/bin/nek",
        version: "0.4.0",
        protocolVersion: 1,
      };
      return { ok: true as const, version: "0.4.0" };
    } finally {
      if (this.localInstallToken === token) this.localInstallToken = undefined;
    }
  }

  async cancelLocalInstall() {
    this.localInstallToken = undefined;
  }

  async selectDirectory() {
    await delay(this.latencyMs);
    return this.selectedDirectory;
  }

  async checkNekUpdate(_target: NekConfigTarget) {
    await delay(Math.max(this.latencyMs, 300));
    return { current: "0.4.0", latest: "0.4.1", updateAvailable: true };
  }

  async runNekUpdate(_target: NekConfigTarget, onLog: (line: string) => void) {
    for (const line of ["Fetching nek 0.4.1", "Installing", "Updated to 0.4.1"]) {
      await delay(Math.max(this.latencyMs, 200));
      onLog(line);
    }
    return { version: "0.4.1" };
  }

  async exportDiagnostics() {
    await delay(Math.max(this.latencyMs, 300));
    return { path: "~/.nek/gui/diagnostics-2026-10-25.zip", sizeBytes: 482_133 };
  }

  async openLogsDirectory() {
    await delay(this.latencyMs);
  }
}
