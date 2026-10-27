import { describe, expect, it } from "vitest";
import { MockNekConfigApi } from "./mockNekConfigApi.js";
import { MockNekSettingsHostApi } from "./mockHostApi.js";
import { MOCK_REMOTE_DISCONNECTED } from "./mockSeed.js";

function hostApi() {
  return new MockNekSettingsHostApi(new MockNekConfigApi(), 0);
}

describe("MockNekSettingsHostApi", () => {
  it("installs nek and reports the new version", async () => {
    const api = hostApi();
    const logs: string[] = [];
    const result = await api.installNek(MOCK_REMOTE_DISCONNECTED, {}, (line) => logs.push(line));
    expect(result).toEqual({ ok: true, version: "0.4.0" });
    expect(logs.at(-1)).toBe("Done");
    expect(
      (await api.listHosts()).find((host) => host.connectionId === MOCK_REMOTE_DISCONNECTED)?.nek,
    ).toMatchObject({ state: "ready", version: "0.4.0" });
  });

  it("cancels an in-flight install without marking nek as installed", async () => {
    const api = hostApi();
    const logs: string[] = [];
    const install = api.installNek(MOCK_REMOTE_DISCONNECTED, {}, (line) => logs.push(line));
    await api.cancelInstall(MOCK_REMOTE_DISCONNECTED);
    await expect(install).rejects.toThrow(/cancelled/);
    expect(
      (await api.listHosts()).find((host) => host.connectionId === MOCK_REMOTE_DISCONNECTED)?.nek,
    ).toMatchObject({ state: "not_installed" });
  });
});
