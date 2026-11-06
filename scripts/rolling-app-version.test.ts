import semver from "semver";
import { describe, expect, it } from "vitest";
import {
  collectRollingAppVersion,
  formatRollingAppVersion,
  resolveAppVersion,
} from "./rolling-app-version.mjs";

describe("resolveAppVersion", () => {
  const facts = { baseline: "0.1.0", buildDate: "20261102", commitCount: "400" };

  it("HEAD 带 v<基线> tag 时是正式版，版本串就是基线", () => {
    expect(resolveAppVersion({ ...facts, headTags: ["v0.1.0"] })).toEqual({
      appVersion: "0.1.0",
      isRelease: true,
    });
  });

  it("beta tag preserves exact version and untagged beta builds remain valid semver", () => {
    const baseline = "0.1.5-beta.1";
    expect(resolveAppVersion({ ...facts, baseline, headTags: [`v${baseline}`] })).toEqual({
      appVersion: baseline,
      isRelease: true,
    });
    const rolling = resolveAppVersion({ ...facts, baseline, headTags: [] }).appVersion;
    expect(rolling).toBe("0.1.5-beta.1.20261102.400");
    expect(semver.valid(rolling)).toBe(rolling);
    expect(semver.gt("0.1.5-beta.2", rolling)).toBe(true);
    expect(semver.gt("0.1.5", rolling)).toBe(true);
  });

  it("没有发版 tag 或 tag 与基线不符时是滚动串", () => {
    for (const headTags of [[], ["v0.2.0"], ["nightly"], ["0.1.0"]]) {
      expect(resolveAppVersion({ ...facts, headTags })).toEqual({
        appVersion: "0.1.0-20261102.400",
        isRelease: false,
      });
    }
  });

  it("同一基线的正式版高于它之前的全部滚动构建", () => {
    const release = resolveAppVersion({ ...facts, headTags: ["v0.1.0"] }).appVersion;
    const rolling = resolveAppVersion({ ...facts, headTags: [] }).appVersion;
    expect(semver.gt(release, rolling)).toBe(true);
  });
});

describe("formatRollingAppVersion", () => {
  it("按 <上游基线>-<YYYYMMDD>.<commitCount> 拼装", () => {
    expect(formatRollingAppVersion("3.14.3", "20261008", 1234)).toBe("3.14.3-20261008.1234");
  });

  // 单调性是滚动更新的生命线：跨天与同天多次构建都必须判新，否则 updater 不推更新。
  it("prerelease 段保证跨天与同天多次构建均单调递增", () => {
    const previousDay = formatRollingAppVersion("3.14.3", "20261008", 9);
    const nextDay = formatRollingAppVersion("3.14.3", "20261009", 1);
    const sameDayLater = formatRollingAppVersion("3.14.3", "20261008", 10);
    expect(semver.gt(nextDay, previousDay)).toBe(true);
    expect(semver.gt(sameDayLater, previousDay)).toBe(true);
    expect(semver.gt(nextDay, sameDayLater)).toBe(true);
  });

  it("上游基线 bump 后大于 bump 前的全部构建", () => {
    const beforeSync = formatRollingAppVersion("3.14.3", "20261009", 4321);
    const afterSync = formatRollingAppVersion("3.15.0", "20261008", 1);
    expect(semver.gt(afterSync, beforeSync)).toBe(true);
  });
});

describe("collectRollingAppVersion", () => {
  it("版本串 semver 合法，electron-updater 的 AppUpdater 构造可直接解析", () => {
    const { appVersion, upstreamBaseline, isRelease } = collectRollingAppVersion();
    // 发版 tag 上的 CI 构建是正式版（等于基线），其他检出是滚动串。
    if (isRelease) expect(appVersion).toBe(upstreamBaseline);
    else expect(appVersion).toMatch(/^\d+\.\d+\.\d+(?:-beta\.\d+\.|-)\d{8}\.\d+$/);
    expect(semver.valid(appVersion)).toBe(appVersion);
    expect(upstreamBaseline).toMatch(/^\d+\.\d+\.\d+(?:-beta\.[1-9]\d*)?$/);
  });

  // 日期段取 commit committer date：同一 commit 在任意时间、任意 CI job 派生结果一致。
  // electron-builder beforePack 校验 bundled-remote manifest 与此相等，collect 按此匹配产物名。
  it("同一 commit 多次收集得到相同版本串", () => {
    expect(collectRollingAppVersion().appVersion).toBe(collectRollingAppVersion().appVersion);
  });
});
