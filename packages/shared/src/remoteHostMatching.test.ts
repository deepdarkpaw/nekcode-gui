import { describe, expect, it } from "vitest";
import {
  inheritConnectedSavedHostId,
  matchSavedRemoteHost,
  withSavedRemoteHostId,
} from "./remoteHostMatching.js";

const target = {
  kind: "ssh",
  host: "dev.example",
  username: "alice",
  sshConfigAlias: "dev",
} as const;
const host = { connectionId: "saved", target, authMethod: "agent" } as const;

describe("saved workspace host association", () => {
  it("uses explicit identity among duplicate profiles but never follows an edited destination", () => {
    const duplicate = { ...host, connectionId: "other" };
    expect(
      matchSavedRemoteHost({ ...target, savedHostId: host.connectionId }, [duplicate, host]),
    ).toBe(host);
    expect(matchSavedRemoteHost({ ...target, savedHostId: "missing" }, [host])).toBeUndefined();
    expect(
      matchSavedRemoteHost({ ...target, host: "elsewhere", savedHostId: host.connectionId }, [
        host,
      ]),
    ).toBeUndefined();
  });

  it("upgrades only unique SSH routes without collapsing aliases, users, ports or keys", () => {
    expect(
      withSavedRemoteHostId({ ...target, host: "DEV.example", port: 22 }, [host]),
    ).toMatchObject({ savedHostId: "saved" });
    expect(withSavedRemoteHostId(target, [host, { ...host, connectionId: "duplicate" }])).toBe(
      target,
    );
    for (const variant of [
      { ...target, sshConfigAlias: undefined },
      { ...target, sshConfigAlias: "other" },
      { ...target, username: "Alice" },
      { ...target, port: 2222 },
      { ...target, privateKeyPath: "/key" },
    ])
      expect(matchSavedRemoteHost(variant, [host])).toBeUndefined();
  });

  it("keeps legacy credentials during migration and does not guess a missing password", () => {
    const passwordHost = { ...host, authMethod: "password" } as const;
    expect(withSavedRemoteHostId(target, [passwordHost])).toBe(target);
    const withPassword = { ...target, password: "ephemeral" };
    expect(withSavedRemoteHostId(withPassword, [passwordHost])).toEqual({
      ...withPassword,
      savedHostId: "saved",
    });
    expect(inheritConnectedSavedHostId(withPassword, { ...target, savedHostId: "saved" })).toEqual({
      ...withPassword,
      savedHostId: "saved",
    });
    expect(
      inheritConnectedSavedHostId(withPassword, { ...target, host: "other", savedHostId: "saved" }),
    ).toBe(withPassword);
  });
});
