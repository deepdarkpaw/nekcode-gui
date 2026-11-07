import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  publishRelease,
  releaseNotes,
  releaseTitle,
  REQUIRED_NEK_VERSION,
} from "./desktop-release-publish.mjs";

const release = {
  tag: "v0.1.0",
  repo: "owner/repo",
  files: ["/tmp/nekcode-0.1.0-win-x64.exe", "/tmp/latest.yml"],
  title: "nekcode v0.1.0",
  notes: "notes",
};

/** 记录 gh 调用；list 返回给定的已有 Release。 */
function githubMock(releases = [], failOn = null) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (failOn && args[1] === failOn) throw new Error(`${failOn} failed`);
    return { stdout: args[1] === "list" ? JSON.stringify(releases) : "" };
  };
  return { run, calls };
}

test("notes list the installer to download for each released platform", () => {
  const notes = releaseNotes({
    productName: "nekcode",
    version: "0.1.0",
    platforms: ["win", "mac"],
  });
  const windows = notes.indexOf("nekcode-0.1.0-win-x64.exe");
  const mac = notes.indexOf("nekcode-0.1.0-mac-arm64.dmg");
  assert.ok(windows > 0 && mac > windows, "Windows first, then macOS");
  assert.match(notes, /win-arm64/);
  assert.match(notes, new RegExp(`nek ${REQUIRED_NEK_VERSION.replaceAll(".", "\\.")}`));
  assert.match(notes, /SmartScreen/);
  assert.match(notes, /隐私与安全性/);
  assert.match(notes, /SHA256SUMS/);
  assert.equal(releaseTitle("nekcode", "v0.1.0"), "nekcode v0.1.0");
});

test("published minimum nek version matches the GUI compatibility gate", () => {
  const source = readFileSync(
    new URL("../../packages/shared/src/nek-protocol/gui-rpc.ts", import.meta.url),
    "utf8",
  );
  const match = source.match(/NEK_GUI_MIN_VERSION\s*=\s*"([^"]+)"/u);
  assert.ok(match, "NEK_GUI_MIN_VERSION must be a string literal");
  assert.equal(REQUIRED_NEK_VERSION, match[1], "release notes must state the enforced nek version");
});

test("notes only describe platforms that are actually released", () => {
  const notes = releaseNotes({ productName: "nekcode", version: "0.1.0", platforms: ["win"] });
  assert.doesNotMatch(notes, /macOS|dmg/);
  assert.throws(() => releaseNotes({ productName: "nekcode", version: "0.1.0", platforms: [] }));
  assert.throws(
    () => releaseNotes({ productName: "nekcode", version: "0.1.0", platforms: ["linux"] }),
    /Unsupported release platform/,
  );
});

test("a new release is drafted, filled with every asset, then published as latest", async () => {
  const { run, calls } = githubMock();
  await publishRelease({ ...release, run });
  assert.deepEqual(
    calls.map((call) => call[2]),
    ["list", "create", "upload", "edit"],
  );
  const create = calls[1];
  for (const flag of ["--verify-tag", "--draft", "--generate-notes"])
    assert.ok(create.includes(flag));
  assert.ok(!create.includes("--prerelease"));
  assert.equal(create[create.indexOf("--title") + 1], "nekcode v0.1.0");
  assert.equal(create[create.indexOf("--notes") + 1], "notes");
  // ["gh", "release", "upload", <tag>, ...files, "--clobber", "--repo", <repo>]
  assert.equal(calls[2][3], "v0.1.0");
  assert.deepEqual(calls[2].slice(4, 6), release.files);
  assert.ok(calls[2].includes("--clobber"));
  // 资产全部上传后才公开，并标记为最新版（electron-updater 读 latest 的 latest.yml）。
  assert.ok(calls[3].includes("--draft=false"));
  assert.ok(calls[3].includes("--latest"));
  for (const call of calls) assert.deepEqual(call.slice(-2), ["--repo", "owner/repo"]);
});

test("prerelease tags are published as prereleases, never as latest", async () => {
  const { run, calls } = githubMock();
  await publishRelease({ ...release, tag: "v0.2.0-beta.1", run });
  assert.ok(calls[1].includes("--prerelease"));
  assert.ok(calls[3].includes("--draft=false"));
  assert.ok(!calls[3].includes("--latest"));
  assert.ok(calls[3].includes("--latest=false"));
  assert.ok(calls[3].includes("--prerelease"));
  const notes = releaseNotes({
    productName: "nekcode",
    version: "0.2.0-beta.1",
    platforms: ["win", "mac"],
  });
  assert.match(notes, /Beta 预发布/);
  assert.doesNotMatch(notes, /会自动检查/);
});

test("a draft left by a failed run is reused; a published release is never overwritten", async () => {
  const draft = githubMock([{ tagName: "v0.1.0", isDraft: true }]);
  await publishRelease({ ...release, run: draft.run });
  assert.deepEqual(
    draft.calls.map((call) => call[2]),
    ["list", "upload", "edit"],
  );
  const published = githubMock([{ tagName: "v0.1.0", isDraft: false }]);
  await assert.rejects(publishRelease({ ...release, run: published.run }), /published/);
  assert.equal(published.calls.length, 1);
});

test("lookup or upload failures stop before the release becomes public", async () => {
  const lookup = githubMock([], "list");
  await assert.rejects(publishRelease({ ...release, run: lookup.run }), /list failed/);
  assert.equal(lookup.calls.length, 1);
  const upload = githubMock([], "upload");
  await assert.rejects(publishRelease({ ...release, run: upload.run }), /upload failed/);
  assert.ok(!upload.calls.some((call) => call.includes("--draft=false")));
  await assert.rejects(
    publishRelease({ ...release, repo: "not a repo", run: lookup.run }),
    /Invalid/,
  );
});
