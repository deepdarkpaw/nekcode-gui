import { createServer, type Server, type Socket } from "node:net";

export const DEFAULT_OAUTH_CALLBACK_PORTS = {
  anthropic: 53692,
  codex: 1455,
} as const;

export interface SSHForwardOutClient {
  forwardOut(
    srcIP: string,
    srcPort: number,
    dstIP: string,
    dstPort: number,
    callback: (error: Error | undefined, socket?: NodeJS.ReadWriteStream) => void,
  ): void;
}

export interface LocalPortForwardHandle {
  localPort: number;
  remotePort: number;
  close(): Promise<void>;
}

function toPort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${label} 必须是 1-65535 的端口：${value}`);
  }
  return value;
}

/**
 * 将固定的本机 OAuth 回调端口转到 SSH 远端 loopback。监听失败直接返回明确错误，
 * 不会自动换端口，因为 OAuth redirect URI 必须保持不变。
 */
export async function forwardLocalPortToRemote(
  client: SSHForwardOutClient,
  localPort: number,
  remotePort: number,
  options: { remoteHost?: string } = {},
): Promise<LocalPortForwardHandle> {
  const validatedLocalPort = toPort(localPort, "localPort");
  const validatedRemotePort = toPort(remotePort, "remotePort");
  const remoteHost = options.remoteHost ?? "127.0.0.1";
  const sockets = new Set<Socket>();
  let server: Server;

  const onConnection = (socket: Socket) => {
    sockets.add(socket);
    const removeSocket = () => sockets.delete(socket);
    socket.once("close", removeSocket);
    client.forwardOut(
      "127.0.0.1",
      validatedLocalPort,
      remoteHost,
      validatedRemotePort,
      (error, forwarded) => {
        if (error || !forwarded) {
          socket.destroy(
            error ??
              new Error(`SSH forwardOut 未返回远端 socket：127.0.0.1:${validatedRemotePort}`),
          );
          return;
        }
        socket.pipe(forwarded as NodeJS.WritableStream);
        (forwarded as NodeJS.ReadableStream).pipe(socket);
        socket.once("close", () => {
          (forwarded as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        });
      },
    );
  };

  server = createServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      const detail = error.code === "EADDRINUSE" ? "本机端口已被占用" : error.message;
      reject(new Error(`OAuth 本机端口转发失败（127.0.0.1:${validatedLocalPort}）：${detail}`));
    };
    const onListening = () => {
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(validatedLocalPort, "127.0.0.1");
  });

  return {
    localPort: validatedLocalPort,
    remotePort: validatedRemotePort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
