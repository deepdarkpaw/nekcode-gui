import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import SSHConfig, { LineType } from "ssh-config";

export interface SSHConfigConnectionOptions {
  host: string;
  port: number;
  username?: string;
  identityFiles: string[];
  proxyJump: string[];
  identitiesOnly: boolean;
  hostName: string;
}

function expandToken(value: string, host: string, port: number, username?: string): string {
  return value
    .replace(/^~(?=$|[\\/])/u, homedir())
    .replace(/%h/gu, host)
    .replace(/%p/gu, String(port))
    .replace(/%r/gu, username ?? "");
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((entry) => entry.trim()).filter(Boolean);
}

function getComputedValue(
  computed: Record<string, string | string[]>,
  name: string,
): string | string[] | undefined {
  const key = Object.keys(computed).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  return key ? computed[key] : undefined;
}

/**
 * 读取并计算 OpenSSH 配置。返回值是连接层唯一消费的参数，不把 alias 当作主机名。
 */
export function computeSshConfigHost(
  host: string,
  configText: string,
  overrides: { username?: string; port?: number } = {},
): SSHConfigConnectionOptions {
  const config = SSHConfig.parse(configText);
  const computed = config.compute(host);
  const hostName = String(getComputedValue(computed, "HostName") ?? host);
  const username =
    overrides.username ?? (String(getComputedValue(computed, "User") ?? "").trim() || undefined);
  const portValue = overrides.port ?? Number(getComputedValue(computed, "Port") ?? 22);
  const port = Number.isInteger(portValue) && portValue > 0 && portValue <= 65535 ? portValue : 22;
  const identityFiles = asList(getComputedValue(computed, "IdentityFile")).map((value) =>
    expandToken(value, host, port, username),
  );
  const proxyJump = asList(getComputedValue(computed, "ProxyJump"))
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value !== "none");
  const identitiesOnly = /^(?:yes|true|on)$/iu.test(
    String(getComputedValue(computed, "IdentitiesOnly") ?? "no"),
  );

  return {
    host,
    hostName: expandToken(hostName, host, port, username),
    port,
    username,
    identityFiles,
    proxyJump,
    identitiesOnly,
  };
}

export async function readSshConfig(filePath = join(homedir(), ".ssh", "config")): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function computeSshConfigHostFromFile(
  host: string,
  options: { filePath?: string; username?: string; port?: number } = {},
): Promise<SSHConfigConnectionOptions> {
  return computeSshConfigHost(host, await readSshConfig(options.filePath), {
    username: options.username,
    port: options.port,
  });
}

/** 列出可选 alias；通配符条目不会暴露给用户。 */
export function listSshConfigHosts(configText: string): string[] {
  const config = SSHConfig.parse(configText);
  const hosts: string[] = [];
  for (const line of config) {
    if (line.type !== LineType.DIRECTIVE || line.param.toLowerCase() !== "host") continue;
    const values = Array.isArray(line.value) ? line.value : [line.value];
    for (const value of values) {
      const alias = String(value).trim();
      if (alias && !/[*!?]/u.test(alias)) hosts.push(alias);
    }
  }
  return [...new Set(hosts)];
}

export async function listSshConfigHostsFromFile(filePath?: string): Promise<string[]> {
  return listSshConfigHosts(await readSshConfig(filePath));
}

export interface SSHJumpClient {
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (error: Error | undefined, socket?: NodeJS.ReadWriteStream) => void,
  ): void;
  end(): void;
}

export interface SSHJumpClientFactory {
  connect(
    options: SSHConfigConnectionOptions,
    sock?: NodeJS.ReadWriteStream,
  ): Promise<SSHJumpClient>;
}

/**
 * 按 ProxyJump 顺序建立 SSH client。每一跳都通过上一跳的 forwardOut 得到下一跳
 * 的 socket，最后一个 client 可以直接用于 exec/forwardOut。
 */
export async function connectSshProxyJump(
  target: SSHConfigConnectionOptions,
  resolveHost: (host: string) => SSHConfigConnectionOptions,
  factory: SSHJumpClientFactory,
): Promise<SSHJumpClient> {
  const hops = [...target.proxyJump, target.host];
  let socket: NodeJS.ReadWriteStream | undefined;
  const clients: SSHJumpClient[] = [];
  try {
    for (let index = 0; index < hops.length; index += 1) {
      const host = index === hops.length - 1 ? target : resolveHost(hops[index]!);
      const client = await factory.connect(host, socket);
      clients.push(client);
      if (index === hops.length - 1) return client;
      const next = index + 1 < hops.length - 1 ? resolveHost(hops[index + 1]!) : target;
      socket = await new Promise<NodeJS.ReadWriteStream>((resolve, reject) => {
        client.forwardOut("127.0.0.1", 0, next.hostName, next.port, (error, forwarded) => {
          if (error || !forwarded) {
            reject(error ?? new Error(`ProxyJump forwardOut 未返回 socket：${next.host}`));
            return;
          }
          resolve(forwarded);
        });
      });
    }
  } catch (error) {
    for (const client of clients.reverse()) client.end();
    throw error;
  }
  throw new Error("ProxyJump 没有建立目标 SSH client");
}
