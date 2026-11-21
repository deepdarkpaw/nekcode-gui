import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IRemoteBackend } from "./backend.js";
import { ReleaseDownloadAssetInstaller } from "./releaseDownloadAssetInstaller.js";
import { RemoteAssetCommandTimeoutError, runRemoteAssetCommand } from "./remoteAssetCommand.js";
import type { RemoteInstallAsset } from "./remoteAssetDeployDecision.js";

vi.mock("./remoteAssetCommand.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./remoteAssetCommand.js")>()),
  runRemoteAssetCommand: vi.fn(),
}));

const capturedCommand = vi.mocked(runRemoteAssetCommand);
const MiB = 1024 ** 2;
const budgets = [
  { id: "node-runtime", size: 42 * MiB, seconds: 396 },
  { id: "server-bundle", size: 128 * MiB, seconds: 900 },
  { id: "bfs", size: 128 * 1024 + 1, seconds: 62 },
] as const;

function installerFixture(downloader: "curl" | "wget") {
  const backend = { kind: "ssh" } as IRemoteBackend;
  const assets = budgets.map(
    ({ id }): RemoteInstallAsset => ({
      component: {
        id,
        version: "v1",
        sha256: "a".repeat(64),
        artifactPath: "archive.tar.gz",
        mount: "component",
        requiredPaths: ["entry"],
      },
      entry: "entry",
      remotePath: `/install/${id}`,
      executable: true,
      marker: { path: `/install/${id}.marker`, contents: "v1" },
    }),
  );
  const installer = new ReleaseDownloadAssetInstaller(
    {
      backend,
      ownerToken: "fixture",
      sha256Tool: "sha256sum",
      report: vi.fn(),
    },
    {
      appVersion: "1.2.3",
      snapshot: new Map([
        ["downloader", downloader],
        ["tar", "1"],
      ]),
      archiveSizes: new Map(budgets.map(({ id, size }) => [id, size])),
    },
  );
  return { assets, installer };
}

describe("SSH release download time budget", () => {
  beforeEach(() => {
    capturedCommand
      .mockReset()
      .mockResolvedValue({ code: 0, stdout: "nek-release-staged\n", stderr: "" });
  });

  it.each([
    ["curl", 2_746_000],
    ["wget", 2_758_000],
  ] as const)(
    "scales %s attempt limits and sums them with retry/cleanup time",
    async (downloader, planMs) => {
      const { installer, assets } = installerFixture(downloader);
      await installer.stage(assets);
      const [, script, , deadline] = capturedCommand.mock.calls[0]!;
      for (const { id, size, seconds } of budgets) {
        expect(script).toContain(`-${id}.tar.gz' ${size} ${seconds}\n`);
      }
      expect(deadline).toBe(planMs);
      if (downloader === "curl") {
        expect(script).toContain("--speed-limit 32768 --speed-time 20");
        expect(script).toContain(
          '--max-time "$attempt_limit" --retry 1 --retry-max-time "$attempt_limit"',
        );
      } else {
        expect(script).toContain("set -- -T 20");
        expect(script).toContain('timeout -k 2 "$attempt_limit" wget');
      }
    },
  );

  it("keeps the cumulative plan deadline distinct from a downloader stall", async () => {
    const { installer, assets } = installerFixture("curl");
    capturedCommand.mockRejectedValue(new RemoteAssetCommandTimeoutError());
    await expect(installer.stage(assets)).rejects.toMatchObject({ failure: { reason: "timeout" } });

    capturedCommand.mockResolvedValue({
      code: 23,
      stdout: "nek-release-failure\tstalled\t0\t28\n",
      stderr: "",
    });
    await expect(installer.stage(assets)).rejects.toMatchObject({
      failure: { reason: "stalled", exitCode: 28 },
    });
  });
});
