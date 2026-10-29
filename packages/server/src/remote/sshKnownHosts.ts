import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildSshRemoteHostKey, type SSHConnectOptions } from "@zcode/shared";
import { getAppConfigDir } from "@zcode/services/node";

/**
 * SSH 主机密钥 TOFU（trust on first use）存储与判定。
 *
 * 背景见 .agents/specs/ssh-remote-hardening.md 缺陷 1：ssh2 未配置 hostVerifier 时接受任意
 * 主机密钥，中间人可冒充目标主机完成密钥交换，骗取用户密码 / 私钥口令。这里按 OpenSSH 默认
 * 策略补齐校验：
 * - 无记录 → 接受并落库（首次连接）；
 * - 记录匹配 → 接受；
 * - 记录不匹配 → 拒绝，且拒绝原因可区分（主机密钥变更 vs 存储故障），不得静默重连。
 *
 * 存储键复用 buildSshRemoteHostKey()：它已刻意排除密码与私钥口令，只含
 * host/port/username/认证方式/私钥路径，这一约束必须保持——known_hosts 落盘文件不得
 * 携带任何凭据。
 */

const KNOWN_HOSTS_SCHEMA_VERSION = 1;
const HOST_KEY_DIGEST_ALGORITHM = "sha256";

export interface KnownHostRecord {
  algorithm: typeof HOST_KEY_DIGEST_ALGORITHM;
  fingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface KnownHostsFile {
  schemaVersion: number;
  hosts: Record<string, KnownHostRecord>;
}

export type HostKeyVerdict =
  | { outcome: "first-use"; record: KnownHostRecord }
  | { outcome: "match"; record: KnownHostRecord }
  | { outcome: "reject"; reason: "changed"; expected: string; received: string }
  | { outcome: "reject"; reason: "store-error"; detail: string };

export function getSSHKnownHostsPath(): string {
  return join(getAppConfigDir(), "ssh", "known-hosts.json");
}

/** 主机公钥指纹：sha256(原始主机公钥) 的 hex。稳定、可复算，不引入外部格式依赖。 */
export function computeHostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash(HOST_KEY_DIGEST_ALGORITHM).update(key).digest("base64").replace(/=+$/u, "")}`;
}

function readHostKeyType(key: Buffer): string {
  if (key.length < 4) return "unknown";
  const length = key.readUInt32BE(0);
  if (length <= 0 || length > key.length - 4) return "unknown";
  return key.subarray(4, 4 + length).toString("ascii") || "unknown";
}

function parseKnownHostIdentity(
  hostKey: string,
): Pick<KnownHostEntry, "host" | "port" | "username"> {
  try {
    const parsed: unknown = JSON.parse(hostKey);
    if (!Array.isArray(parsed)) return {};
    return {
      ...(typeof parsed[1] === "string" ? { host: parsed[1] } : {}),
      ...(typeof parsed[2] === "number" ? { port: parsed[2] } : {}),
      ...(typeof parsed[3] === "string" ? { username: parsed[3] } : {}),
    };
  } catch {
    return {};
  }
}

function readKnownHostsFile(value: unknown): KnownHostsFile | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Partial<KnownHostsFile>;
  if (candidate.schemaVersion !== KNOWN_HOSTS_SCHEMA_VERSION) {
    return null;
  }
  if (typeof candidate.hosts !== "object" || candidate.hosts === null) {
    return null;
  }

  const hosts: Record<string, KnownHostRecord> = {};
  for (const [hostKey, record] of Object.entries(candidate.hosts)) {
    if (typeof record !== "object" || record === null) {
      continue;
    }
    const candidateRecord = record as Partial<KnownHostRecord>;
    if (
      candidateRecord.algorithm !== HOST_KEY_DIGEST_ALGORITHM ||
      typeof candidateRecord.fingerprint !== "string" ||
      typeof candidateRecord.firstSeenAt !== "string" ||
      typeof candidateRecord.lastSeenAt !== "string"
    ) {
      continue;
    }
    hosts[hostKey] = {
      algorithm: candidateRecord.algorithm,
      fingerprint: candidateRecord.fingerprint,
      firstSeenAt: candidateRecord.firstSeenAt,
      lastSeenAt: candidateRecord.lastSeenAt,
    };
  }

  return { schemaVersion: KNOWN_HOSTS_SCHEMA_VERSION, hosts };
}

async function writeKnownHostsFile(
  filePath: string,
  hosts: Record<string, KnownHostRecord>,
): Promise<void> {
  const payload: KnownHostsFile = { schemaVersion: KNOWN_HOSTS_SCHEMA_VERSION, hosts };
  await mkdir(dirname(filePath), { recursive: true });
  // 先写 .part 再 rename：多窗口各自 host 进程可能并发首连同一目标，
  // 原子替换保证不会留下写了一半的 JSON 把后续读取全部判成存储故障。
  const tempPath = `${filePath}.part`;
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export interface SSHHostKeyStoreOptions {
  filePath?: string;
  now?: () => Date;
}

export interface KnownHostEntry extends KnownHostRecord {
  hostKey: string;
  host?: string;
  port?: number;
  username?: string;
}

export interface VerifyHostKeyOptions {
  /** 首次见到密钥时只判定，不落盘；由确认回调决定是否调用 remember。 */
  recordFirstUse?: boolean;
}

/**
 * 主机密钥存储。filePath 可注入以便测试落到临时目录；默认跟随应用配置根
 * （<数据根>/.nek/gui/v2/ssh/known-hosts.json），新目录首次使用自动创建，
 * 不涉及既有数据迁移。
 */
export class SSHHostKeyStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private loaded: KnownHostsFile | null = null;
  private loadPromise: Promise<KnownHostsFile | null> | null = null;

  constructor(options: SSHHostKeyStoreOptions = {}) {
    this.filePath = options.filePath ?? getSSHKnownHostsPath();
    this.now = options.now ?? (() => new Date());
  }

  private async load(): Promise<KnownHostsFile | null> {
    if (this.loaded) {
      return this.loaded;
    }
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = await readFile(this.filePath, "utf8");
          const parsed = readKnownHostsFile(JSON.parse(raw));
          if (!parsed) {
            // 文件存在但不可识别（损坏或被旧版本写过）：按存储故障处理，调用方 fail-closed。
            // 不静默重建——那会把“密钥变更”伪装成“首次连接”。
            return null;
          }
          this.loaded = parsed;
          return parsed;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
            const empty: KnownHostsFile = { schemaVersion: KNOWN_HOSTS_SCHEMA_VERSION, hosts: {} };
            this.loaded = empty;
            return empty;
          }
          throw error;
        }
      })();
    }
    return this.loadPromise;
  }

  /**
   * 落盘并同步内存缓存。只写文件不更新缓存会让同一进程内的第二次判定读到旧快照，
   * 把“密钥变更”误判成“首次连接”——TOFU 的整个价值就在于同一存储上的连续判定。
   */
  private async persist(hosts: Record<string, KnownHostRecord>): Promise<void> {
    await writeKnownHostsFile(this.filePath, hosts);
    this.loaded = { schemaVersion: KNOWN_HOSTS_SCHEMA_VERSION, hosts };
  }

  /** 三方判定；首次连接与匹配都会刷新落库（lastSeenAt）。存储任何故障都 fail-closed。 */
  async verify(
    target: SSHConnectOptions,
    fingerprint: string,
    options: VerifyHostKeyOptions = {},
  ): Promise<HostKeyVerdict> {
    const hostKey = buildSshRemoteHostKey(target);

    let hosts: Record<string, KnownHostRecord>;
    try {
      const file = await this.load();
      if (!file) {
        return {
          outcome: "reject",
          reason: "store-error",
          detail: `known_hosts 无法解析：${this.filePath}`,
        };
      }
      hosts = file.hosts;
    } catch (error) {
      return {
        outcome: "reject",
        reason: "store-error",
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const existing = hosts[hostKey];
    const nowIso = this.now().toISOString();

    if (!existing) {
      const record: KnownHostRecord = {
        algorithm: HOST_KEY_DIGEST_ALGORITHM,
        fingerprint,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
      };
      if (options.recordFirstUse === false) {
        return { outcome: "first-use", record };
      }
      try {
        await this.persist({ ...hosts, [hostKey]: record });
      } catch (error) {
        // 首连判定通过但记录写不进去（只读配置目录、磁盘故障等）时选择拒绝而不是放行：
        // TOFU 的全部价值在于“下次能发现变更”，写不进去就等于静默失去这层保护。
        // 拒绝信息带路径与原因，用户能直接定位（通常是配置目录权限），好过无声降级。
        return {
          outcome: "reject",
          reason: "store-error",
          detail: `首连记录写入失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return { outcome: "first-use", record };
    }

    if (existing.fingerprint !== fingerprint) {
      // 密钥变更：绝不覆盖记录、绝不静默重连，原因可区分地上抛。
      return {
        outcome: "reject",
        reason: "changed",
        expected: existing.fingerprint,
        received: fingerprint,
      };
    }

    const refreshed: KnownHostRecord = { ...existing, lastSeenAt: nowIso };
    try {
      await this.persist({ ...hosts, [hostKey]: refreshed });
    } catch {
      // lastSeenAt 刷新失败不影响安全判定：记录已在位且匹配，连接继续。
      return { outcome: "match", record: existing };
    }
    return { outcome: "match", record: refreshed };
  }

  /** 在用户确认后记录一个首次出现的指纹；密钥已经变更时仍然拒绝覆盖。 */
  async remember(target: SSHConnectOptions, fingerprint: string): Promise<KnownHostRecord> {
    const verdict = await this.verify(target, fingerprint);
    if (verdict.outcome === "reject") {
      throw new Error(
        verdict.reason === "changed" ? "SSH 主机密钥已变更，不能覆盖已有记录" : verdict.detail,
      );
    }
    return verdict.record;
  }

  async listKnownHosts(): Promise<KnownHostEntry[]> {
    const file = await this.load();
    if (!file) throw new Error(`known_hosts 无法解析：${this.filePath}`);
    return Object.entries(file.hosts).map(([hostKey, record]) => ({
      hostKey,
      ...parseKnownHostIdentity(hostKey),
      ...record,
    }));
  }

  async removeKnownHost(targetOrHostKey: SSHConnectOptions | string): Promise<boolean> {
    const file = await this.load();
    if (!file) throw new Error(`known_hosts 无法解析：${this.filePath}`);
    const hostKey =
      typeof targetOrHostKey === "string"
        ? targetOrHostKey
        : buildSshRemoteHostKey(targetOrHostKey);
    if (!(hostKey in file.hosts)) return false;
    const hosts = { ...file.hosts };
    delete hosts[hostKey];
    await this.persist(hosts);
    return true;
  }
}

export async function listKnownHosts(
  options: SSHHostKeyStoreOptions = {},
): Promise<KnownHostEntry[]> {
  return new SSHHostKeyStore(options).listKnownHosts();
}

export async function removeKnownHost(
  targetOrHostKey: SSHConnectOptions | string,
  options: SSHHostKeyStoreOptions = {},
): Promise<boolean> {
  return new SSHHostKeyStore(options).removeKnownHost(targetOrHostKey);
}

export interface SSHHostKeyRejection {
  hostKey: string;
  reason: "changed" | "store-error" | "user-declined";
  detail: string;
  expectedFingerprint?: string;
  receivedFingerprint?: string;
}

export interface HostKeyConfirmation {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
}

/**
 * 把拒绝原因翻译成用户可操作的错误文案。变更与存储故障必须可区分：
 * 前者是安全事件（可能是中间人），后者是环境问题（通常是配置目录权限）。
 */
export function formatHostKeyRejectionError(
  rejection: SSHHostKeyRejection,
  filePath: string,
): Error {
  if (rejection.reason === "changed") {
    const fingerprints =
      rejection.expectedFingerprint && rejection.receivedFingerprint
        ? `旧指纹=${rejection.expectedFingerprint}，新指纹=${rejection.receivedFingerprint}。`
        : "";
    return new Error(
      `SSH 主机密钥校验失败：${fingerprints}本次连接的主机密钥与记录不一致，已拒绝连接以防中间人攻击。` +
        `若该服务器确实更换了主机密钥，请删除 ${filePath} 中此主机的记录后重试。`,
    );
  }

  if (rejection.reason === "user-declined") {
    return new Error(`SSH 主机密钥未获用户确认，已拒绝连接：${rejection.detail}`);
  }

  return new Error(`SSH 主机密钥记录不可用，已拒绝连接：${rejection.detail}`);
}

/**
 * 生成 ssh2 的 hostVerifier。判定为拒绝时先通过 onRejection 记录可区分的原因，
 * 再回调 verify(false)——ssh2 对 verify(false) 只抛固定的
 * "Host denied (verification failed)"，不记录就分不清是密钥变更还是存储故障。
 */
export function createSSHHostVerifier(params: {
  store: SSHHostKeyStore;
  target: SSHConnectOptions;
  requireHostKeyConfirmation?: boolean;
  confirmHostKey?: (confirmation: HostKeyConfirmation) => Promise<boolean> | boolean;
  onRejection: (rejection: SSHHostKeyRejection) => void;
}): (key: Buffer, verify: (valid: boolean) => void) => void {
  const { store, target, onRejection } = params;
  const hostKey = buildSshRemoteHostKey(target);
  const requireConfirmation = params.requireHostKeyConfirmation ?? Boolean(params.confirmHostKey);

  return (key, verify) => {
    void (async () => {
      const fingerprint = computeHostKeyFingerprint(key);
      const verdict = await store.verify(target, fingerprint, {
        recordFirstUse: !requireConfirmation || !params.confirmHostKey,
      });
      if (verdict.outcome === "reject") {
        const detail =
          verdict.reason === "changed"
            ? `旧指纹=${verdict.expected}，新指纹=${verdict.received}`
            : verdict.detail;
        onRejection({
          hostKey,
          reason: verdict.reason,
          detail,
          expectedFingerprint: verdict.reason === "changed" ? verdict.expected : undefined,
          receivedFingerprint: verdict.reason === "changed" ? verdict.received : undefined,
        });
        verify(false);
        return;
      }
      if (verdict.outcome === "first-use" && requireConfirmation && params.confirmHostKey) {
        const accepted = await params.confirmHostKey({
          host: target.host,
          port: target.port ?? 22,
          keyType: readHostKeyType(key),
          fingerprint,
        });
        if (!accepted) {
          onRejection({
            hostKey,
            reason: "user-declined",
            detail: `用户拒绝记录主机密钥 ${fingerprint}`,
            receivedFingerprint: fingerprint,
          });
          verify(false);
          return;
        }
        await store.remember(target, fingerprint);
      }
      verify(true);
    })().catch((error: unknown) => {
      onRejection({
        hostKey,
        reason: "store-error",
        detail: error instanceof Error ? error.message : String(error),
      });
      verify(false);
    });
  };
}
