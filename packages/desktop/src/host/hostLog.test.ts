import { safeLogArgs } from "@zcode/shared";
import { describe, expect, it } from "vitest";
import { stringifyRemoteConnectionProgress } from "./hostLog.js";

const throughProgressLog = (value: unknown) =>
  stringifyRemoteConnectionProgress(safeLogArgs(safeLogArgs([value])));

describe("remote deployment progress", () => {
  it("keeps the source, size, elapsed time and fallback reason after privacy filtering", () => {
    expect(
      throughProgressLog({ remoteAssetTransfer: "release-download", totalBytes: 24 * 1024 ** 2 }),
    ).toContain("GitHub Releases 下载（24.0 MB）");
    expect(
      throughProgressLog({
        remoteAssetTransfer: "bundled-upload",
        totalBytes: 2048,
        durationMs: 1250,
      }),
    ).toContain("本机上传（2.0 KB，用时 1.3 秒）");
    expect(
      throughProgressLog({
        remoteAssetTransfer: "upload-fallback",
        reason: "http",
        statusCode: 404,
        durationMs: 500,
      }),
    ).toContain("HTTP 错误 404，用时 0.5 秒；改用本机上传");
  });

  it("does not forward raw remote output or arbitrary diagnostic reasons", () => {
    const result = throughProgressLog({
      remoteAssetTransfer: "upload-fallback",
      reason: "private proxy token",
      durationMs: 500,
    });
    expect(result).not.toContain("private proxy token");
    expect(result).not.toContain("改用本机上传");
  });
});
