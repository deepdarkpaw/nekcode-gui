import { createServer, connect } from "node:net";
import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { forwardLocalPortToRemote } from "./sshPortForward.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate test port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

describe("SSH local port forwarding", () => {
  it("forwards each local connection to remote loopback", async () => {
    const localPort = await freePort();
    const handle = await forwardLocalPortToRemote(
      {
        forwardOut: (_srcIp, _srcPort, dstIp, dstPort, callback) => {
          expect(dstIp).toBe("127.0.0.1");
          expect(dstPort).toBe(9000);
          const remote = new Duplex({
            read() {},
            write(chunk, _encoding, done) {
              this.push(chunk);
              done();
            },
          });
          callback(undefined, remote);
        },
      },
      localPort,
      9000,
    );
    const client = connect(localPort, "127.0.0.1");
    const received = new Promise<string>((resolve) =>
      client.once("data", (chunk) => resolve(chunk.toString())),
    );
    client.write("oauth-code");
    expect(await received).toBe("oauth-code");
    client.destroy();
    await handle.close();
  });

  it("reports occupied callback ports without choosing another port", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string")
      throw new Error("failed to allocate occupied port");
    await expect(
      forwardLocalPortToRemote({ forwardOut: () => undefined }, address.port, 1455),
    ).rejects.toThrow(`127.0.0.1:${address.port}`);
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve())),
    );
  });
});
