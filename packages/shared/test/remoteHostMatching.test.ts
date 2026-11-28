import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  inheritConnectedSavedHostId,
  matchSavedRemoteHost,
  withSavedRemoteHostId,
} from "../src/remoteHostMatching.js";

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
    assert.equal(
      matchSavedRemoteHost({ ...target, savedHostId: host.connectionId }, [duplicate, host]),
      host,
    );
    assert.equal(matchSavedRemoteHost({ ...target, savedHostId: "missing" }, [host]), undefined);
    assert.equal(
      matchSavedRemoteHost({ ...target, host: "elsewhere", savedHostId: host.connectionId }, [
        host,
      ]),
      undefined,
    );
  });

  it("upgrades only unique SSH routes without collapsing aliases, users, ports or keys", () => {
    const legacy = { ...target, host: "DEV.example", port: 22 };
    assert.deepEqual(withSavedRemoteHostId(legacy, [host]), { ...legacy, savedHostId: "saved" });
    assert.equal(
      withSavedRemoteHostId(target, [host, { ...host, connectionId: "duplicate" }]),
      target,
    );
    for (const variant of [
      { ...target, sshConfigAlias: undefined },
      { ...target, sshConfigAlias: "other" },
      { ...target, username: "Alice" },
      { ...target, port: 2222 },
      { ...target, privateKeyPath: "/key" },
    ])
      assert.equal(matchSavedRemoteHost(variant, [host]), undefined);
  });

  it("keeps legacy credentials during migration and does not guess a missing password", () => {
    const passwordHost = { ...host, authMethod: "password" } as const;
    assert.equal(withSavedRemoteHostId(target, [passwordHost]), target);
    const withPassword = { ...target, password: "ephemeral" };
    assert.deepEqual(withSavedRemoteHostId(withPassword, [passwordHost]), {
      ...withPassword,
      savedHostId: "saved",
    });
    assert.deepEqual(
      inheritConnectedSavedHostId(withPassword, { ...target, savedHostId: "saved" }),
      { ...withPassword, savedHostId: "saved" },
    );
    assert.equal(
      inheritConnectedSavedHostId(withPassword, { ...target, host: "other", savedHostId: "saved" }),
      withPassword,
    );
  });
});
