/**
 * nek RPC 客户端的错误分类。
 *
 * 纪律：每类失败都要能被上层映射成用户可见、可重试的动作，不允许用 `catch {}` 吞掉。
 */

/** 命令失败（`success: false`）：nek 侧给出的原因。 */
export class NekRpcCommandError extends Error {
  constructor(
    readonly command: string,
    readonly detail: string,
    readonly requestId?: string,
  ) {
    super(`nek ${command} failed: ${detail}`);
    this.name = "NekRpcCommandError";
  }
}

/** 命令在预算内没有响应。进程仍然健康，调用方可以重试。 */
export class NekRpcTimeoutError extends Error {
  constructor(
    readonly command: string,
    readonly timeoutMs: number,
    readonly requestId?: string,
  ) {
    super(`nek ${command} timed out after ${timeoutMs} ms`);
    this.name = "NekRpcTimeoutError";
  }
}

/** 进程在请求挂起时退出/被杀：所有挂起请求以此结束，并带上 stderr 尾部。 */
export class NekRpcProcessExitedError extends Error {
  constructor(
    readonly code: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly stderrTail: string,
    readonly cause?: Error,
  ) {
    const how = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    super(`nek RPC process exited (${how})${stderrTail ? `\n${stderrTail}` : ""}`);
    this.name = "NekRpcProcessExitedError";
  }
}

/** 客户端已关闭，请求不再有结果。 */
export class NekRpcClosedError extends Error {
  constructor(message = "nek RPC client is closed") {
    super(message);
    this.name = "NekRpcClosedError";
  }
}

/** 写 stdin 失败（管道已关闭或对端崩了）。 */
export class NekRpcWriteError extends Error {
  constructor(
    readonly command: string,
    readonly cause: Error,
  ) {
    super(`failed to write nek ${command} to stdin: ${cause.message}`);
    this.name = "NekRpcWriteError";
  }
}
