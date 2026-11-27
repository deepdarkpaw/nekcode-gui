import type { NekRemoteConfigConnection } from "./remoteHostExecutor.js";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function appendOutput(buffer: { value: string }, chunk: unknown): void {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  buffer.value += text;
  if (Buffer.byteLength(buffer.value, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error("远端配置操作输出超过 4 MB 上限");
  }
}

export async function runRemoteConfigCommand(
  connection: NekRemoteConfigConnection,
  command: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const stream = await connection.exec(command);
  const stdout = { value: "" };
  const stderr = { value: "" };
  let outputError: Error | undefined;
  const collect = (buffer: { value: string }, chunk: unknown): void => {
    if (outputError) return;
    try {
      appendOutput(buffer, chunk);
    } catch (error) {
      outputError = error instanceof Error ? error : new Error(String(error));
    }
  };
  stream.stdout.on("data", (chunk) => collect(stdout, chunk));
  stream.stderr.on("data", (chunk) => collect(stderr, chunk));
  // ssh2 可能先报退出码、后派发最后一段输出；读完两路输出再解析 JSON。
  const [code] = await Promise.all([
    new Promise<number>((resolve) => stream.onClose(resolve)),
    waitForEnd(stream.stdout),
    waitForEnd(stream.stderr),
  ]);
  if (outputError) throw outputError;
  return { stdout: stdout.value, stderr: stderr.value, code };
}

function waitForEnd(stream: NodeJS.ReadableStream): Promise<void> {
  const state = stream as NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean };
  if (state.readableEnded || state.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      stream.off("end", done);
      stream.off("close", done);
      stream.off("error", done);
      resolve();
    };
    stream.on("end", done);
    stream.on("close", done);
    stream.on("error", done);
  });
}
