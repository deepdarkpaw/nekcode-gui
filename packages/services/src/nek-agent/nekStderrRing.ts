import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

/**
 * nek 进程 stderr 的有界环形缓冲。
 *
 * stderr 只承载诊断与日志（stdout 是协议），所以这里不需要保留全部内容：
 * 崩溃/启动失败时 GUI 要给用户看"最后发生了什么"，只要有界的尾部就够。
 * 上限按行与字节双重约束，超限丢最旧的记录。
 */

export const NEK_STDERR_MAX_LINES = 200;
export const NEK_STDERR_MAX_BYTES = 64 * 1024;
/** 单行上限：避免一条没有换行的巨行把缓冲撑爆。 */
export const NEK_STDERR_MAX_LINE_BYTES = 8 * 1024;

export interface NekStderrRingOptions {
  maxLines?: number;
  maxBytes?: number;
}

export class NekStderrRingBuffer {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly kept: string[] = [];
  private bytes = 0;
  private dropped = 0;

  constructor(options: NekStderrRingOptions = {}) {
    this.maxLines = Math.max(1, options.maxLines ?? NEK_STDERR_MAX_LINES);
    this.maxBytes = Math.max(1, options.maxBytes ?? NEK_STDERR_MAX_BYTES);
  }

  push(line: string): void {
    const normalized =
      line.length > NEK_STDERR_MAX_LINE_BYTES
        ? `${line.slice(0, NEK_STDERR_MAX_LINE_BYTES)}…`
        : line;
    this.kept.push(normalized);
    this.bytes += Buffer.byteLength(normalized, "utf8") + 1;
    while (this.kept.length > this.maxLines || this.bytes > this.maxBytes) {
      const removed = this.kept.shift();
      if (removed === undefined) break;
      this.bytes -= Buffer.byteLength(removed, "utf8") + 1;
      this.dropped += 1;
    }
  }

  lines(): readonly string[] {
    return this.kept;
  }

  /** 尾部若干行（默认全部保留行）拼成的文本，用于错误摘要。 */
  text(maxLines = this.maxLines): string {
    const slice =
      maxLines >= this.kept.length ? this.kept : this.kept.slice(this.kept.length - maxLines);
    return slice.join("\n");
  }

  /** 因为上限被丢弃的行数（诊断用：>0 说明摘要不是全部）。 */
  get droppedLineCount(): number {
    return this.dropped;
  }

  clear(): void {
    this.kept.length = 0;
    this.bytes = 0;
    this.dropped = 0;
  }
}

/**
 * 把一个可读流按 LF 拆成行并交给 `onLine`（剥 CR）。
 * 与协议 stdout 不同，stderr 不做字节上限报错：超长行按 {@link NEK_STDERR_MAX_LINE_BYTES} 截断。
 */
export function attachNekStderrReader(
  stream: Readable,
  onLine: (line: string) => void,
): () => void {
  const decoder = new StringDecoder("utf8");
  let pending = "";

  const emit = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) return;
    onLine(line);
  };

  const onData = (chunk: Buffer | string) => {
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const index = pending.indexOf("\n");
      if (index === -1) break;
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      emit(line);
    }
    if (pending.length > NEK_STDERR_MAX_LINE_BYTES) {
      // 还没有换行的超长残行：先冲出去，剩下的继续累积。
      emit(pending);
      pending = "";
    }
  };

  const onEnd = () => {
    pending += decoder.end();
    if (pending.length > 0) emit(pending);
    pending = "";
  };

  stream.on("data", onData);
  stream.once("end", onEnd);
  stream.once("close", onEnd);

  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("close", onEnd);
  };
}
