import type { Readable } from "node:stream";

/**
 * nek RPC 的 JSONL 分帧（严格 LF）。
 *
 * 为什么不用 `node:readline`：readline 还会在 `U+2028` / `U+2029` 处断行，而这两个字符在 JSON
 * 字符串里完全合法（见 nek `docs/json.md`、`docs/rpc.md`）。只扫描新收到字节里的 LF，
 * 整行收齐后才解码 UTF-8，避免跨块字符被打断或对累积长字符串反复扫描、拷贝。
 * 剥掉可选的 `\r` 以兼容 CRLF 写入端。
 */

/** 单行上限：超过即视为对端异常（正常一条记录远小于此）。 */
export const NEK_JSONL_MAX_LINE_BYTES = 64 * 1024 * 1024;

export class NekJsonlLineTooLongError extends Error {
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(`nek JSONL record exceeded ${maxBytes} bytes (${bytes} bytes before the next LF)`);
    this.name = "NekJsonlLineTooLongError";
  }
}

/** 序列化一条严格 JSONL 记录（单行 + LF）。 */
export function serializeNekJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export interface NekJsonlDecoderOptions {
  /** 单行字节上限，默认 {@link NEK_JSONL_MAX_LINE_BYTES}。 */
  maxLineBytes?: number;
  /** 收到一条完整记录（已剥 `\r`，不含 LF）。 */
  onLine: (line: string) => void;
  /**
   * 超限报错。超限后解码器丢弃到下一个 LF 并继续工作：既有记录仍然可信，
   * 上层据错误决定是否终止进程，而不是被静默截断的半个对象骗过去。
   */
  onLineTooLong?: (error: NekJsonlLineTooLongError) => void;
}

/**
 * 增量 JSONL 解码器：`write()` 喂块，`end()` 收尾（尾部未以 LF 结束的残余按一条记录处理）。
 * 超限的残余不会被当成记录投递。
 */
const LINE_BUFFER_BLOCK_BYTES = 64 * 1024;

export class NekJsonlDecoder {
  private readonly maxLineBytes: number;
  private readonly blocks: Buffer[] = [];
  private lastBlockUsed = 0;
  private pendingBytes = 0;
  private overflowed = false;

  constructor(private readonly options: NekJsonlDecoderOptions) {
    this.maxLineBytes = options.maxLineBytes ?? NEK_JSONL_MAX_LINE_BYTES;
    if (!Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 1)
      throw new RangeError("nek JSONL line limit must be a positive safe integer");
  }

  /** 当前未完成行的实际字节数；非法 UTF-8 不会让替换字符改变限额记账。 */
  get pendingByteCount(): number {
    return this.pendingBytes;
  }

  /** 超限后等待 LF 期间必须为零，不能继续积累被丢弃的正文。 */
  get retainedByteCount(): number {
    return this.overflowed ? 0 : this.pendingBytes;
  }

  write(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const stop = newline < 0 ? bytes.length : newline;
      this.append(bytes.subarray(start, stop));
      if (newline < 0) return;
      this.finishLine();
      start = newline + 1;
    }
  }

  end(): void {
    if (this.pendingBytes > 0) this.finishLine();
  }

  private append(bytes: Buffer): void {
    this.pendingBytes = Math.min(Number.MAX_SAFE_INTEGER, this.pendingBytes + bytes.length);
    if (this.overflowed) return;
    if (this.pendingBytes > this.maxLineBytes) {
      this.overflowed = true;
      this.blocks.length = 0;
      this.lastBlockUsed = 0;
      this.options.onLineTooLong?.(
        new NekJsonlLineTooLongError(this.pendingBytes, this.maxLineBytes),
      );
      return;
    }
    let offset = 0;
    while (offset < bytes.length) {
      let block = this.blocks.at(-1);
      if (!block || this.lastBlockUsed === block.length) {
        block = Buffer.allocUnsafe(Math.min(LINE_BUFFER_BLOCK_BYTES, this.maxLineBytes));
        this.blocks.push(block);
        this.lastBlockUsed = 0;
      }
      const count = Math.min(bytes.length - offset, block.length - this.lastBlockUsed);
      bytes.copy(block, this.lastBlockUsed, offset, offset + count);
      this.lastBlockUsed += count;
      offset += count;
    }
  }

  /** Join/decode once per accepted record; reset ownership before invoking user callbacks. */
  private finishLine(): void {
    let line: string | undefined;
    if (!this.overflowed) {
      const bytes =
        this.blocks.length === 1
          ? this.blocks[0]!.subarray(0, this.lastBlockUsed)
          : Buffer.concat(this.blocks, this.pendingBytes);
      line = bytes.toString("utf8");
    }
    this.blocks.length = 0;
    this.lastBlockUsed = 0;
    this.pendingBytes = 0;
    this.overflowed = false;
    if (line !== undefined) this.options.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
}

export interface NekJsonlRecordHandlers {
  /** 一条记录解析成功（已 `JSON.parse`）。 */
  onRecord: (record: unknown) => void;
  /** 一行不是合法 JSON。默认交给 `onRecord` 之外的日志；不传则忽略空行之外的一切错误。 */
  onParseError?: (error: Error, line: string) => void;
  onLineTooLong?: (error: NekJsonlLineTooLongError) => void;
}

/**
 * 把一条可读流接到记录处理器上。返回解绑函数。
 * 空行（只有 `\r` 或什么都没有）被跳过；这些行不是协议记录。
 */
export function attachNekJsonlReader(
  stream: Readable,
  handlers: NekJsonlRecordHandlers,
  options: { maxLineBytes?: number } = {},
): () => void {
  const decoder = new NekJsonlDecoder({
    maxLineBytes: options.maxLineBytes,
    onLineTooLong: handlers.onLineTooLong,
    onLine: (line) => {
      if (line.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        handlers.onParseError?.(error instanceof Error ? error : new Error(String(error)), line);
        return;
      }
      handlers.onRecord(parsed);
    },
  });

  const onData = (chunk: Buffer | string) => decoder.write(chunk);
  const onEnd = () => decoder.end();

  stream.on("data", onData);
  stream.once("end", onEnd);
  stream.once("close", onEnd);

  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("close", onEnd);
  };
}
