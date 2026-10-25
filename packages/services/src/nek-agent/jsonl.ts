import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";

/**
 * nek RPC 的 JSONL 分帧（严格 LF）。
 *
 * 为什么不用 `node:readline`：readline 还会在 `U+2028` / `U+2029` 处断行，而这两个字符在 JSON
 * 字符串里完全合法（见 nek `docs/json.md`、`docs/rpc.md`）。这里用 `StringDecoder` 保证跨块的
 * UTF-8 序列不被打断，只按 `\n` 切分，并剥掉可选的 `\r` 以兼容 CRLF 写入端。
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
export class NekJsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private readonly maxLineBytes: number;
  private buffer = "";
  private pendingBytes = 0;
  private overflowed = false;

  constructor(private readonly options: NekJsonlDecoderOptions) {
    this.maxLineBytes = options.maxLineBytes ?? NEK_JSONL_MAX_LINE_BYTES;
  }

  /** 当前未完成行的字节数（诊断用）。 */
  get pendingByteCount(): number {
    return this.pendingBytes;
  }

  write(chunk: Buffer | string): void {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    this.pendingBytes +=
      typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.length;
    this.buffer += text;
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      // 记账用解码后文本的字节数：合法 UTF-8 与原始字节一致；非法序列会被替换符放大，
      // 但这里只服务于"单行上限"这个粗粒度守卫，漂移被 clamp 掉。
      this.pendingBytes = Math.max(0, this.pendingBytes - (Buffer.byteLength(rawLine, "utf8") + 1));
      if (this.overflowed) {
        // 超限的残余在这里丢弃，后面的记录照常切分。
        this.overflowed = false;
        continue;
      }
      const lineBytes = Buffer.byteLength(rawLine, "utf8");
      if (lineBytes > this.maxLineBytes) {
        this.options.onLineTooLong?.(new NekJsonlLineTooLongError(lineBytes, this.maxLineBytes));
        continue;
      }
      this.emitLine(rawLine);
    }
    if (!this.overflowed && this.pendingBytes > this.maxLineBytes) {
      this.overflowed = true;
      this.options.onLineTooLong?.(
        new NekJsonlLineTooLongError(this.pendingBytes, this.maxLineBytes),
      );
      this.buffer = "";
    }
  }

  end(): void {
    this.buffer += this.decoder.end();
    if (!this.overflowed && this.buffer.length > 0) {
      const rawLine = this.buffer;
      this.buffer = "";
      this.pendingBytes = 0;
      if (Buffer.byteLength(rawLine, "utf8") > this.maxLineBytes) {
        this.options.onLineTooLong?.(
          new NekJsonlLineTooLongError(Buffer.byteLength(rawLine, "utf8"), this.maxLineBytes),
        );
        return;
      }
      this.emitLine(rawLine);
      return;
    }
    this.buffer = "";
    this.pendingBytes = 0;
    this.overflowed = false;
  }

  private emitLine(rawLine: string): void {
    this.options.onLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
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
