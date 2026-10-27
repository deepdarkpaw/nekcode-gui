import { describe, expect, it } from "vitest";
import { computeSshConfigHost, connectSshProxyJump, listSshConfigHosts } from "./sshConfig.js";

const configText = `
Host *
  User default-user
  IdentitiesOnly yes
Host jump-a
  HostName jump-a.example
  User gateway
  Port 2200
Host jump-b
  HostName jump-b.example
  ProxyJump jump-a
Host app
  HostName %h.internal
  User app-user
  Port 2222
  IdentityFile ~/.ssh/%h
  ProxyJump jump-a,jump-b
`;

describe("ssh config", () => {
  it("以 compute 结果展开连接参数并排除通配符 alias", () => {
    const app = computeSshConfigHost("app", configText);
    expect(app.hostName).toBe("app.internal");
    expect(app.username).toBe("default-user");
    expect(app.port).toBe(2222);
    expect(app.identityFiles[0]).toContain("/.ssh/app");
    expect(app.proxyJump).toEqual(["jump-a", "jump-b"]);
    expect(app.identitiesOnly).toBe(true);
    expect(listSshConfigHosts(configText)).toEqual(["jump-a", "jump-b", "app"]);
  });

  it("将每一跳 forwardOut 得到的 socket 传给下一跳", async () => {
    const calls: Array<{ host: string; sock?: NodeJS.ReadWriteStream }> = [];
    const forwardedSockets = [
      { pipe() {} } as unknown as NodeJS.ReadWriteStream,
      { pipe() {} } as unknown as NodeJS.ReadWriteStream,
    ];
    let forwardIndex = 0;
    const clients = ["jump-a", "jump-b", "app"].map((name) => ({
      forwardOut: (
        _src: string,
        _srcPort: number,
        _dst: string,
        _port: number,
        callback: Function,
      ) => callback(undefined, forwardedSockets[forwardIndex++]),
      end: () => undefined,
      name,
    }));
    let clientIndex = 0;
    const final = await connectSshProxyJump(
      computeSshConfigHost("app", configText),
      (host) => computeSshConfigHost(host, configText),
      {
        connect: async (options, sock) => {
          calls.push({ host: options.host, sock });
          return clients[clientIndex++]!;
        },
      },
    );
    expect(final).toBe(clients[2]);
    expect(calls.map((call) => call.host)).toEqual(["jump-a", "jump-b", "app"]);
    expect(calls[0]?.sock).toBeUndefined();
    expect(calls[1]?.sock).toBe(forwardedSockets[0]);
    expect(calls[2]?.sock).toBe(forwardedSockets[1]);
  });
});
