/**
 * nek 模式的 v4 附件上传事务（begin / chunk / commit / abort）。
 *
 * 粘贴的截图没有本地路径，渲染层按协议分片上传；这里把分片落到 GUI 数据目录下的暂存文件，
 * commit 校验 sha256 后返回绝对路径作为 ref。发送时 `toNekImages` 按 ref 读文件、转成
 * nek prompt 的 images，所以暂存文件只需活到消息发出。
 *
 * - 只收图片：nek 只接受图片附件，其它类型在 begin 就明确拒绝，不拖到发送时才失败；
 * - 有界：进行中的上传数与字节数遵守协议上限，已提交未发送的文件另有条数/字节上限，
 *   超出时先淘汰最久未用的已提交文件；进行中的上传超时作废，已提交文件超过保留期删除；
 * - 可重试：同一 uploadId 的 begin、重复 chunk、重复 commit 都是幂等的；分片按偏移写入，
 *   失败重试不会重复追加；
 * - 本实例的文件放在独立子目录，退出时整体删除；崩溃遗留的旧目录在下次启动时按保留期清理。
 */
import { createHash, randomUUID, type Hash } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PROTOCOL_V4_LIMITS,
  type V4AttachmentBeginResult,
  type V4AttachmentChunkResult,
  type V4AttachmentCommitResult,
} from "@zcode/shared/zcode-protocol-v4";

/** 已提交、等待发送的图片上限（条数 / 字节）；超出时淘汰最久未用的。 */
export const NEK_ATTACHMENT_MAX_COMMITTED_UPLOADS = 64;
const MAX_COMMITTED_BYTES = 4 * PROTOCOL_V4_LIMITS.attachmentUploadMaxStagedBytes;
const DISK_NAME_MAX_CHARS = 80;
const UPLOAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

export const NEK_ATTACHMENT_IMAGE_ONLY_MESSAGE = "nek 仅支持图片附件；请使用 @路径引用文件";
export const NEK_ATTACHMENT_STAGING_FULL_MESSAGE = "图片暂存已满：请先发送或移除已添加的图片后重试";

interface UploadIdentity {
  sessionId: string;
  uploadId: string;
}

export interface NekAttachmentBeginInput extends UploadIdentity {
  fileName: string;
  mime: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
}

interface NekAttachmentChunkInput extends UploadIdentity {
  chunkIndex: number;
  dataBase64: string;
}

interface NekAttachmentStagingOptions {
  /** 暂存根目录；本实例在其下建独立子目录。 */
  rootDir: string;
  now?: () => number;
  logger?: { warn: (...args: unknown[]) => void };
}

interface StagedUpload extends NekAttachmentBeginInput {
  key: string;
  connectionId?: string;
  diskBase: string;
  partPath: string;
  nextChunkIndex: number;
  receivedBytes: number;
  hash: Hash;
  digest?: string;
  /** commit 后的绝对路径（即 ref）。 */
  ref?: string;
  touchedAt: number;
  queue: Promise<unknown>;
}

function invalid(field: string): Error {
  return new Error(`fault.attachment.invalidParams: ${field}`);
}

function validateBegin(input: NekAttachmentBeginInput): void {
  if (!input.sessionId) throw invalid("sessionId");
  if (input.uploadId.length > 128 || !UPLOAD_ID_PATTERN.test(input.uploadId))
    throw invalid("uploadId");
  const name = input.fileName;
  if (!name || name.length > 255 || ["\u0000", "\r", "\n"].some((char) => name.includes(char)))
    throw invalid("fileName");
  if (!input.mime.toLowerCase().startsWith("image/"))
    throw new Error(NEK_ATTACHMENT_IMAGE_ONLY_MESSAGE);
  if (!Number.isInteger(input.totalBytes) || input.totalBytes <= 0) throw invalid("totalBytes");
  if (input.totalBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes)
    throw new Error("proto.payloadTooLarge");
  const minChunks = Math.ceil(input.totalBytes / PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes);
  const maxChunks = Math.min(input.totalBytes, PROTOCOL_V4_LIMITS.attachmentUploadMaxChunks);
  if (
    !Number.isInteger(input.totalChunks) ||
    input.totalChunks < minChunks ||
    input.totalChunks > maxChunks
  )
    throw invalid("totalChunks");
  if (!CHECKSUM_PATTERN.test(input.checksum)) throw invalid("checksum");
}

/** 严格 base64：长度为 4 的倍数、字符集合法、`=` 只出现在末尾，解码长度与声明一致。 */
function decodeStrictBase64(value: string): Buffer {
  if (value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) throw new Error("proto.invalidBase64");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== (value.length / 4) * 3 - padding) throw new Error("proto.invalidBase64");
  return bytes;
}

/** 磁盘文件名只保留可移植字符；ref 的显示名来自 AttachmentRef.fileName，这里只求安全。 */
function diskFileName(fileName: string): string {
  const cleaned = fileName
    .replace(/[\\/:*?"<>|]/gu, "-")
    .replace(/\p{Cc}/gu, "")
    .trim();
  const safe = cleaned.replace(/^\.+/u, "") || "image";
  return safe.length <= DISK_NAME_MAX_CHARS ? safe : safe.slice(-DISK_NAME_MAX_CHARS);
}

function sameDeclaration(upload: StagedUpload, input: NekAttachmentBeginInput): boolean {
  return (
    upload.fileName === input.fileName &&
    upload.mime === input.mime &&
    upload.totalBytes === input.totalBytes &&
    upload.totalChunks === input.totalChunks &&
    upload.checksum === input.checksum
  );
}

export class NekAttachmentStaging {
  private readonly uploads = new Map<string, StagedUpload>();
  private readonly instanceName = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly instanceDir: string;
  private readonly now: () => number;
  private ready: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly options: NekAttachmentStagingOptions) {
    this.instanceDir = join(options.rootDir, this.instanceName);
    this.now = options.now ?? Date.now;
  }

  async begin(
    input: NekAttachmentBeginInput,
    connectionId?: string,
  ): Promise<V4AttachmentBeginResult> {
    this.assertAlive();
    validateBegin(input);
    await this.ensureReady();
    const key = `${input.sessionId}\0${input.uploadId}`;
    const existing = this.uploads.get(key);
    if (existing) {
      if (!sameDeclaration(existing, input)) throw new Error("fault.attachment.uploadConflict");
      existing.touchedAt = this.now();
      return this.beginResult(existing);
    }
    await this.expire();
    await this.makeRoomForStaging(input.totalBytes);
    const diskBase = createHash("sha256").update(key).digest("hex").slice(0, 32);
    const upload: StagedUpload = {
      ...input,
      key,
      ...(connectionId ? { connectionId } : {}),
      diskBase,
      partPath: join(this.instanceDir, `${diskBase}.part`),
      nextChunkIndex: 0,
      receivedBytes: 0,
      hash: createHash("sha256"),
      touchedAt: this.now(),
      queue: Promise.resolve(),
    };
    this.uploads.set(key, upload);
    try {
      await writeFile(upload.partPath, new Uint8Array(0));
    } catch (error) {
      this.uploads.delete(key);
      throw error;
    }
    return this.beginResult(upload);
  }

  async chunk(input: NekAttachmentChunkInput): Promise<V4AttachmentChunkResult> {
    const upload = this.require(input);
    return await this.serialize(upload, async () => {
      if (upload.ref) throw new Error("fault.attachment.alreadyCommitted");
      // 重复分片（ACK 丢失后的重试）：已写入过，直接回报进度。
      if (input.chunkIndex < upload.nextChunkIndex) return this.chunkResult(upload);
      if (input.chunkIndex !== upload.nextChunkIndex || input.chunkIndex >= upload.totalChunks)
        throw new Error("fault.attachment.chunkOutOfOrder");
      const bytes = decodeStrictBase64(input.dataBase64);
      if (bytes.length > PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes)
        throw new Error("proto.payloadTooLarge");
      const last = input.chunkIndex === upload.totalChunks - 1;
      const received = upload.receivedBytes + bytes.length;
      if ((!last && bytes.length === 0) || received > upload.totalBytes)
        throw new Error("fault.attachment.sizeMismatch");
      if (last && received !== upload.totalBytes) throw new Error("fault.attachment.sizeMismatch");
      // 按偏移写：写失败后的重试覆盖同一区间，不会重复追加。
      const handle = await open(upload.partPath, "r+");
      try {
        await handle.write(bytes, 0, bytes.length, upload.receivedBytes);
      } finally {
        await handle.close();
      }
      upload.hash.update(bytes);
      upload.receivedBytes = received;
      upload.nextChunkIndex += 1;
      upload.touchedAt = this.now();
      return this.chunkResult(upload);
    });
  }

  async commit(input: UploadIdentity): Promise<V4AttachmentCommitResult> {
    const upload = this.require(input);
    return await this.serialize(upload, async () => {
      if (upload.ref) return { ref: upload.ref };
      if (
        upload.nextChunkIndex !== upload.totalChunks ||
        upload.receivedBytes !== upload.totalBytes
      )
        throw new Error("fault.attachment.incomplete");
      upload.digest ??= `sha256:${upload.hash.digest("hex")}`;
      if (upload.digest !== upload.checksum) {
        await this.discard(upload);
        throw new Error("fault.attachment.checksumMismatch");
      }
      await this.makeRoomForCommitted(upload);
      const finalPath = join(
        this.instanceDir,
        `${upload.diskBase}-${diskFileName(upload.fileName)}`,
      );
      await rename(upload.partPath, finalPath);
      upload.ref = finalPath;
      upload.touchedAt = this.now();
      return { ref: finalPath };
    });
  }

  async abort(input: UploadIdentity): Promise<void> {
    const upload = this.uploads.get(`${input.sessionId}\0${input.uploadId}`);
    if (!upload) return;
    await this.serialize(upload, async () => await this.discard(upload));
  }

  /** 连接关闭：作废它进行中的上传；已提交的文件留到保留期（ref 可能已交给发送链路）。 */
  async closeConnection(connectionId: string): Promise<void> {
    const pending = [...this.uploads.values()].filter(
      (upload) => upload.connectionId === connectionId && !upload.ref,
    );
    await Promise.all(
      pending.map(
        async (upload) => await this.serialize(upload, async () => await this.discard(upload)),
      ),
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.uploads.clear();
    await rm(this.instanceDir, { recursive: true, force: true });
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("fault.attachment.stagingClosed");
  }

  private require(input: UploadIdentity): StagedUpload {
    this.assertAlive();
    const upload = this.uploads.get(`${input.sessionId}\0${input.uploadId}`);
    if (!upload) throw new Error("fault.attachment.unknownUpload");
    return upload;
  }

  private serialize<T>(upload: StagedUpload, run: () => Promise<T>): Promise<T> {
    const result = upload.queue.then(run, run);
    upload.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private beginResult(upload: StagedUpload): V4AttachmentBeginResult {
    return upload.ref
      ? {
          uploadId: upload.uploadId,
          state: "committed",
          nextChunkIndex: upload.totalChunks,
          ref: upload.ref,
        }
      : { uploadId: upload.uploadId, state: "staging", nextChunkIndex: upload.nextChunkIndex };
  }

  private chunkResult(upload: StagedUpload): V4AttachmentChunkResult {
    return { uploadId: upload.uploadId, nextChunkIndex: upload.nextChunkIndex };
  }

  private async discard(upload: StagedUpload): Promise<void> {
    if (this.uploads.get(upload.key) === upload) this.uploads.delete(upload.key);
    await rm(upload.partPath, { force: true });
    if (upload.ref) await rm(upload.ref, { force: true });
  }

  /** 进行中的上传超时作废；已提交文件超过保留期删除。 */
  private async expire(): Promise<void> {
    const now = this.now();
    const expired = [...this.uploads.values()].filter((upload) => {
      const ttl = upload.ref
        ? PROTOCOL_V4_LIMITS.attachmentUnreferencedTtlMs
        : PROTOCOL_V4_LIMITS.attachmentUploadTtlMs;
      return now - upload.touchedAt >= ttl;
    });
    await Promise.all(expired.map(async (upload) => await this.discard(upload)));
  }

  private async makeRoomForStaging(totalBytes: number): Promise<void> {
    const staging = [...this.uploads.values()].filter((upload) => !upload.ref);
    const stagedBytes = staging.reduce((sum, upload) => sum + upload.totalBytes, 0);
    if (
      staging.length >= PROTOCOL_V4_LIMITS.attachmentUploadMaxConcurrent ||
      stagedBytes + totalBytes > PROTOCOL_V4_LIMITS.attachmentUploadMaxStagedBytes
    )
      throw new Error(NEK_ATTACHMENT_STAGING_FULL_MESSAGE);
  }

  /** 已提交文件超出上限时，按最久未用淘汰（被淘汰的 ref 发送时会报文件不存在，可重新添加）。 */
  private async makeRoomForCommitted(incoming: StagedUpload): Promise<void> {
    const committed = [...this.uploads.values()]
      .filter((upload) => upload.ref)
      .sort((left, right) => left.touchedAt - right.touchedAt);
    let count = committed.length + 1;
    let bytes = committed.reduce((sum, upload) => sum + upload.totalBytes, incoming.totalBytes);
    for (const upload of committed) {
      if (count <= NEK_ATTACHMENT_MAX_COMMITTED_UPLOADS && bytes <= MAX_COMMITTED_BYTES) return;
      await this.discard(upload);
      count -= 1;
      bytes -= upload.totalBytes;
    }
  }

  private async ensureReady(): Promise<void> {
    this.ready ??= this.prepareDirectory().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    await this.ready;
  }

  private async prepareDirectory(): Promise<void> {
    await mkdir(this.instanceDir, { recursive: true });
    await this.sweepStaleInstances();
  }

  /** 崩溃遗留的其它实例目录：超过保留期就删除；清理失败只告警，不影响本次上传。 */
  private async sweepStaleInstances(): Promise<void> {
    const cutoff = this.now() - PROTOCOL_V4_LIMITS.attachmentUnreferencedTtlMs;
    try {
      for (const entry of await readdir(this.options.rootDir)) {
        if (entry === this.instanceName) continue;
        const path = join(this.options.rootDir, entry);
        if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
      }
    } catch (error) {
      this.options.logger?.warn("failed to sweep stale nek attachment staging directories", error);
    }
  }
}
