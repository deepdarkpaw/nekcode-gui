import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, parseReleaseArgs, planRelease } from "../release.mjs";

test("release arguments require exactly one x.y.z version", () => {
  assert.deepEqual(parseReleaseArgs(["0.2.0"]), { version: "0.2.0", push: true });
  assert.deepEqual(parseReleaseArgs(["v0.2.0", "--no-push"]), { version: "0.2.0", push: false });
  assert.throws(() => parseReleaseArgs([]), /Usage/);
  assert.throws(() => parseReleaseArgs(["0.2.0", "0.3.0"]), /Usage/);
  assert.throws(() => parseReleaseArgs(["0.2"]), /x\.y\.z/);
  // 正式版不带 prerelease 段：滚动构建的版本串只用于日常产物，不能当发布版本。
  assert.throws(() => parseReleaseArgs(["0.2.0-20261102.400"]), /x\.y\.z/);
  assert.throws(() => parseReleaseArgs(["0.2.0", "--force"]), /Unknown option/);
  assert.deepEqual(parseReleaseArgs(["v0.1.5-beta.1"]), { version: "0.1.5-beta.1", push: true });
  for (const version of [
    "0.1.5-beta",
    "0.1.5-beta.0",
    "0.1.5-beta.01",
    "00.1.5",
    "0.1.5-alpha.1",
    "0.1.5-beta.1+build",
  ]) {
    assert.throws(() => parseReleaseArgs([version]), /x\.y\.z/);
  }
});

test("versions compare numerically per component", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.ok(compareVersions("0.1.0", "0.1.1") < 0);
  assert.ok(compareVersions("0.1.5-beta.1", "0.1.4") > 0);
  assert.ok(compareVersions("0.1.5-beta.10", "0.1.5-beta.2") > 0);
  assert.ok(compareVersions("0.1.5-beta.1", "0.1.5") < 0);
  assert.ok(compareVersions("0.1.5", "0.1.5-beta.10") > 0);
  assert.equal(compareVersions("0.1.5-beta.1", "0.1.5-beta.1"), 0);
});

test("release plan bumps newer versions, tags the current one and refuses older ones", () => {
  assert.deepEqual(planRelease({ current: "0.1.0", target: "0.1.1" }), {
    bump: true,
    tag: "v0.1.1",
  });
  // 首个版本：package.json 已是 0.1.0，只打 tag 不提交。
  assert.deepEqual(planRelease({ current: "0.1.0", target: "0.1.0" }), {
    bump: false,
    tag: "v0.1.0",
  });
  assert.throws(() => planRelease({ current: "0.2.0", target: "0.1.9" }), /older/);
  assert.deepEqual(planRelease({ current: "0.1.4", target: "0.1.5-beta.1" }), {
    bump: true,
    tag: "v0.1.5-beta.1",
  });
  assert.deepEqual(planRelease({ current: "0.1.5-beta.2", target: "0.1.5" }), {
    bump: true,
    tag: "v0.1.5",
  });
  assert.throws(() => planRelease({ current: "0.1.5", target: "0.1.5-beta.1" }), /older/);
});
