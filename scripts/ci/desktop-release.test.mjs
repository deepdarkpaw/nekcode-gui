import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  artifactNames,
  assembleReleaseAssets,
  collectArtifacts,
  mergeUpdateInfo,
  publishDraft,
  readUpdateInfo,
  releaseUpdateInfoNames,
  sourceUpdateInfoName,
  updateInfoChannelName,
  validateTag,
  verifyReleaseAssets,
} from "./desktop-release.mjs";
import { desktopProductIdentities } from "../../packages/desktop/scripts/desktop-product-identity.mjs";
import { collectRollingAppVersion } from "../rolling-app-version.mjs";

const version = "3.14.0";
// 产物名改由构建期产品身份派生（bugfix：曾硬编码 `ZCodium-`，身份改为 `ZCodium Exp`
// 后 CI 的 Build job 全部 ENOENT）。这里显式取 production 身份，使断言不依赖运行环境的
// ZCODE_ENV / ZCODE_PREVIEW_IDENTITY——CI 设了 production，本机裸跑会解析成 Preview。
const identity = desktopProductIdentities.production;
const allNames = [
  ...artifactNames("linux", version, undefined, identity),
  ...artifactNames("win", version, undefined, identity),
  ...artifactNames("mac", version, undefined, identity),
];

function updateInfoYaml(urls, releaseDate = "2026-01-01T00:00:00.000Z") {
  // 直接写 electron-builder 的 YAML 形状（标量 + files 列表），避免测试再引入 yaml 依赖。
  const lines = [`version: ${version}`, "files:"];
  for (const url of urls) {
    lines.push(`  - url: ${url}`, `    sha512: sha512-${url}`, "    size: 1");
  }
  if (urls.length > 0) lines.push(`path: ${urls[0]}`, `sha512: sha512-${urls[0]}`);
  lines.push(`releaseDate: "${releaseDate}"`);
  return `${lines.join("\n")}\n`;
}

/** 按 (身份, 平台) 写出 electron-updater 会拉取的 latest*.yml，只覆盖实际存在安装包的架构。 */
async function writeUpdateInfo(directory, names, flavors = [identity]) {
  const available = new Set(names);
  for (const flavor of flavors) {
    const groups = [
      ["win", "x64", artifactNames("win", version, undefined, flavor)],
      ["mac", "x64", artifactNames("mac", version, undefined, flavor)],
      ["linux", "x64", artifactNames("linux", version, "x64", flavor)],
      ["linux", "arm64", artifactNames("linux", version, "arm64", flavor)],
    ];
    for (const [platform, arch, candidates] of groups) {
      const urls = candidates.filter((name) => available.has(name));
      if (urls.length === 0) continue;
      await writeFile(
        join(directory, updateInfoChannelName(platform, flavor.flavor, arch)),
        updateInfoYaml(urls),
      );
    }
  }
}

async function fixture(t, names = allNames, flavors = [identity]) {
  const directory = await mkdtemp(join(tmpdir(), "nekcode-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of names) await writeFile(join(directory, name), `artifact: ${name}`);
  await writeUpdateInfo(directory, names, flavors);
  return directory;
}

test("baseline tag validation remains compatible and rolling tags match exactly", () => {
  validateTag("v3.14.0", version);
  validateTag("v3.15.0-rc.1", "3.15.0-rc.1");
  const rolling = "3.15.1-20261010.1234";
  validateTag(`v${rolling}`, "3.15.1", rolling);
  assert.throws(() => validateTag("v3.15.1", "3.15.1", rolling));
  for (const tag of ["3.14.0", "v3.14.1", "v3.14.0\\n", "v3.14.0;echo x", "v3.15.1"]) {
    assert.throws(() => validateTag(tag, version));
  }
  for (const wrongRolling of [
    "3.15.1-20261011.1234",
    "3.15.1-20261010.1235",
    "3.15.1-20261010.1234+build",
  ]) {
    assert.throws(() => validateTag(`v${wrongRolling}`, "3.15.1", rolling));
  }
  for (const invalid of ["../3.14.0", "03.14.0", "3.14", "3.14.0-01", "3.14.0+build"]) {
    assert.throws(() => validateTag(`v${invalid}`, invalid));
  }
  assert.throws(() => artifactNames("sunos", version));
});

test("rolling app version is stable for the same checked-out commit", () => {
  assert.deepEqual(collectRollingAppVersion(), collectRollingAppVersion());
});

// tag 只标识上游基线（v3.14.4），产物名带的是构建期滚动版本串（#38 起 electron-builder
// 用 extraMetadata.version 命名）。collect 与 publish 的 verifyReleaseAssets 都必须按滚动串
// 匹配，否则 tag 一发就按基线名找不到产物。这里钉住 artifactNames 对 prerelease 串可用。
test("artifact names accept the rolling prerelease build version", () => {
  const rolling = "3.14.4-20261009.258";
  // linux x64 的 AppImage 产物名用 x86_64（builder-util 的 getArtifactArchName 特例）。
  assert.ok(
    artifactNames("linux", rolling, "x64", identity)[0].includes(`nekcode-${rolling}-linux-x86_64`),
  );
  assert.notEqual(
    artifactNames("linux", rolling, "x64", identity)[0],
    artifactNames("linux", "3.14.4", "x64", identity)[0],
  );
});

test("collect copies the platform installers with their update metadata and nothing else", async (t) => {
  const source = await fixture(t);
  const output = await fixture(t, []);
  await collectArtifacts(source, output, "linux", version, "x64", identity);
  const linuxX64 = artifactNames("linux", version, "x64", identity);
  assert.deepEqual((await readdir(output)).sort(), [...linuxX64, "latest-linux.yml"].sort());
  assert.equal(await readFile(join(output, linuxX64[0]), "utf8"), `artifact: ${linuxX64[0]}`);
  // 其他平台、其他架构及其更新元数据不得混入同一个 job 的产物集合。
  await assert.rejects(readFile(join(output, artifactNames("win", version, "x64", identity)[0])), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(join(output, sourceUpdateInfoName("linux", "arm64"))), {
    code: "ENOENT",
  });
});

test("collect fails when electron-builder produced no update metadata", async (t) => {
  const source = await fixture(t);
  await rm(join(source, "latest.yml"));
  await assert.rejects(
    collectArtifacts(source, await fixture(t, []), "win", version, "x64", identity),
    /Missing update metadata for win\/x64/,
  );
});

test("collect selects the requested product identity", async (t) => {
  const preview = desktopProductIdentities.preview;
  const source = await fixture(t, [
    ...artifactNames("linux", version, "x64", identity),
    ...artifactNames("linux", version, "x64", preview),
  ]);
  const output = await fixture(t, []);
  await collectArtifacts(source, output, "linux", version, "x64", preview);
  assert.deepEqual(
    (await readdir(output)).sort(),
    [...artifactNames("linux", version, "x64", preview), "latest-linux.yml"].sort(),
  );
});

test("Windows x64 and arm64 artifacts are collected independently", async (t) => {
  // 交叉打包：x64 job 与 arm64 job 各自只收自己的产物；不传 arch 才收全部。
  const source = await fixture(t);
  const x64 = await fixture(t, []);
  await collectArtifacts(source, x64, "win", version, "x64", identity);
  assert.deepEqual(
    (await readdir(x64)).sort(),
    [artifactNames("win", version, "x64", identity)[0], "latest.yml"].sort(),
  );

  const arm64 = await fixture(t, []);
  await collectArtifacts(source, arm64, "win", version, "arm64", identity);
  assert.deepEqual(
    (await readdir(arm64)).sort(),
    [artifactNames("win", version, "arm64", identity)[0], "latest.yml"].sort(),
  );

  const both = await fixture(t, []);
  await collectArtifacts(source, both, "win", version, undefined, identity);
  assert.deepEqual(
    (await readdir(both)).sort(),
    [
      artifactNames("win", version, "arm64", identity)[0],
      artifactNames("win", version, "x64", identity)[0],
      "latest.yml",
    ].sort(),
  );

  await assert.rejects(
    collectArtifacts(source, await fixture(t, []), "win", version, "riscv64", identity),
  );
});

test("macOS arm64 and x64 installers are collected per architecture", async (t) => {
  // 与 Windows 一样按架构分 job 收取：arm64 job 只收 arm64 的 dmg/zip，x64 同理。
  const source = await fixture(t);
  const arm64 = await fixture(t, []);
  await collectArtifacts(source, arm64, "mac", version, "arm64", identity);
  assert.deepEqual(
    (await readdir(arm64)).sort(),
    [
      artifactNames("mac", version, "arm64", identity).find((n) => n.endsWith(".dmg")),
      artifactNames("mac", version, "arm64", identity).find((n) => n.endsWith(".zip")),
      "latest-mac.yml",
    ].sort(),
  );

  const x64 = await fixture(t, []);
  await collectArtifacts(source, x64, "mac", version, "x64", identity);
  assert.deepEqual(
    (await readdir(x64)).sort(),
    [
      artifactNames("mac", version, "x64", identity).find((n) => n.endsWith(".dmg")),
      artifactNames("mac", version, "x64", identity).find((n) => n.endsWith(".zip")),
      "latest-mac.yml",
    ].sort(),
  );

  const both = await fixture(t, []);
  await collectArtifacts(source, both, "mac", version, undefined, identity);
  assert.equal((await readdir(both)).length, 5);

  await assert.rejects(
    collectArtifacts(source, await fixture(t, []), "mac", version, "riscv64", identity),
  );
});

test("Linux x64 and arm64 artifacts are collected independently", async (t) => {
  // 修复依据：Linux arm64 与 x64 的产物名差异来自 builder-util 的 getArtifactArchName
  // （AppImage/deb 用 arm64，rpm/pacman 用 aarch64），此前映射表只有 x64 一族，
  // arm64 job 会因找不到预期文件名直接失败。
  const source = await fixture(t);

  const x64 = await fixture(t, []);
  await collectArtifacts(source, x64, "linux", version, "x64", identity);
  assert.deepEqual(
    (await readdir(x64)).sort(),
    [...artifactNames("linux", version, "x64", identity), "latest-linux.yml"].sort(),
  );

  const arm64 = await fixture(t, []);
  await collectArtifacts(source, arm64, "linux", version, "arm64", identity);
  assert.deepEqual(
    (await readdir(arm64)).sort(),
    [...artifactNames("linux", version, "arm64", identity), "latest-linux-arm64.yml"].sort(),
  );

  const both = await fixture(t, []);
  await collectArtifacts(source, both, "linux", version, undefined, identity);
  assert.equal((await readdir(both)).length, 10);
});

test("missing, empty, wrong-version and extra assets block release", async (t) => {
  const missing = await fixture(t, allNames.slice(0, -1));
  await assert.rejects(verifyReleaseAssets(missing, version, identity));
  const empty = await fixture(t);
  await writeFile(join(empty, allNames[0]), "");
  await assert.rejects(verifyReleaseAssets(empty, version, identity), /empty/);
  const extra = await fixture(t);
  await writeFile(join(extra, "ZCodium-3.13.0-win-x64.exe"), "old");
  await assert.rejects(verifyReleaseAssets(extra, version, identity), /Unexpected/);
  const wrongVersion = await fixture(
    t,
    allNames.map((name) => name.replace(version, "3.13.0")),
  );
  await assert.rejects(verifyReleaseAssets(wrongVersion, version, identity));
});

test("dual-product checksums cover exactly 28 installers from both identities", async (t) => {
  const preview = desktopProductIdentities.preview;
  const names = [
    ...artifactNames("linux", version, undefined, identity),
    ...artifactNames("win", version, undefined, identity),
    ...artifactNames("mac", version, undefined, identity),
    ...artifactNames("linux", version, undefined, preview),
    ...artifactNames("win", version, undefined, preview),
    ...artifactNames("mac", version, undefined, preview),
  ];
  const directory = await fixture(t, names, [identity, preview]);
  const paths = await verifyReleaseAssets(directory, version, [identity, preview]);
  // 28 个安装包 + 8 份更新元数据（三平台 × 两身份，Windows/macOS 按架构合并）+ SHA256SUMS
  assert.equal(paths.length, 37);
  assert.equal(
    (await readFile(join(directory, "SHA256SUMS"), "utf8")).trim().split("\n").length,
    28,
  );
});

test("dual-product verification rejects empty, duplicate, missing, empty, wrong-version, and extra inputs", async (t) => {
  const preview = desktopProductIdentities.preview;
  const names = [
    ...artifactNames("linux", version, undefined, identity),
    ...artifactNames("win", version, undefined, identity),
    ...artifactNames("mac", version, undefined, identity),
    ...artifactNames("linux", version, undefined, preview),
    ...artifactNames("win", version, undefined, preview),
    ...artifactNames("mac", version, undefined, preview),
  ];
  const complete = await fixture(t, names, [identity, preview]);
  await assert.rejects(verifyReleaseAssets(complete, version, []), /identit/i);
  await assert.rejects(verifyReleaseAssets(complete, version, [identity, identity]), /duplicate/i);
  await assert.rejects(
    verifyReleaseAssets(await fixture(t, names.slice(0, -1), [identity, preview]), version, [
      identity,
      preview,
    ]),
  );
  const empty = await fixture(t, names, [identity, preview]);
  await writeFile(join(empty, names[0]), "");
  await assert.rejects(verifyReleaseAssets(empty, version, [identity, preview]), /empty/);
  const wrong = await fixture(
    t,
    names.map((name) => name.replace(version, "3.13.0")),
    [identity, preview],
  );
  await assert.rejects(verifyReleaseAssets(wrong, version, [identity, preview]));
  const extra = await fixture(t, [...names, "unexpected.bin"], [identity, preview]);
  await assert.rejects(verifyReleaseAssets(extra, version, [identity, preview]), /Unexpected/);
});

test("checksums cover exactly the fourteen validated installers and can be regenerated", async (t) => {
  const directory = await fixture(t);
  const paths = await verifyReleaseAssets(directory, version, identity);
  const expected = allNames
    .toSorted()
    .map((name) => {
      const hash = createHash("sha256").update(`artifact: ${name}`).digest("hex");
      return `${hash}  ${name}\n`;
    })
    .join("");
  assert.equal(await readFile(join(directory, "SHA256SUMS"), "utf8"), expected);
  assert.equal(paths.length, 19);
  await verifyReleaseAssets(directory, version, identity);
});

test("update metadata filenames follow electron-updater channel rules", () => {
  // electron-updater 的 Provider#getChannelFilePrefix：Windows 无平台后缀，
  // Linux 追加 -linux（非 x64 再加 -<arch>），macOS 追加 -mac。
  assert.equal(updateInfoChannelName("win", "production", "x64"), "latest.yml");
  assert.equal(updateInfoChannelName("win", "production", "arm64"), "latest.yml");
  assert.equal(updateInfoChannelName("win", "preview", "x64"), "latest-preview.yml");
  assert.equal(updateInfoChannelName("linux", "production", "x64"), "latest-linux.yml");
  assert.equal(updateInfoChannelName("linux", "production", "arm64"), "latest-linux-arm64.yml");
  assert.equal(
    updateInfoChannelName("linux", "preview", "arm64"),
    "latest-preview-linux-arm64.yml",
  );
  assert.equal(updateInfoChannelName("mac", "production", "arm64"), "latest-mac.yml");
  assert.equal(updateInfoChannelName("mac", "preview", "x64"), "latest-preview-mac.yml");
  // electron-builder 写盘用的是 latest 通道名，与生产身份的 canonical 名同源。
  assert.equal(sourceUpdateInfoName("win", "arm64"), "latest.yml");
  assert.equal(sourceUpdateInfoName("linux", "arm64"), "latest-linux-arm64.yml");
  assert.throws(() => updateInfoChannelName("freebsd", "production", "x64"));
  assert.throws(() => updateInfoChannelName("win", "production", "riscv64"));
  assert.deepEqual(releaseUpdateInfoNames([identity]), [
    "latest-linux-arm64.yml",
    "latest-linux.yml",
    "latest-mac.yml",
    "latest.yml",
  ]);
  assert.equal(releaseUpdateInfoNames([identity, desktopProductIdentities.preview]).length, 8);
});

test("merging per-architecture metadata keeps both installers and rejects mismatches", () => {
  const x64 = artifactNames("win", version, "x64", identity)[0];
  const arm64 = artifactNames("win", version, "arm64", identity)[0];
  const merged = mergeUpdateInfo([
    {
      document: {
        version,
        files: [{ url: x64, sha512: "a", size: 1 }],
        releaseDate: "2026-01-01T00:00:00.000Z",
      },
      file: "x64/latest.yml",
    },
    {
      document: {
        version,
        files: [{ url: arm64, sha512: "b", size: 2 }],
        releaseDate: "2026-01-02T00:00:00.000Z",
      },
      file: "arm64/latest.yml",
    },
  ]);
  assert.equal(merged.document.version, version);
  assert.deepEqual(
    merged.document.files.map((file) => file.url),
    [x64, arm64],
  );
  assert.equal(merged.document.path, x64);
  assert.equal(merged.document.sha512, "a");
  assert.equal(merged.document.releaseDate, "2026-01-02T00:00:00.000Z");
  // 重复 url 只保留一份（同一架构被收集两次时不能让 files[] 出现重复项）。
  const deduped = mergeUpdateInfo([
    { document: { version, files: [{ url: x64, sha512: "a", size: 1 }] }, file: "a/latest.yml" },
    { document: { version, files: [{ url: x64, sha512: "a", size: 1 }] }, file: "b/latest.yml" },
  ]);
  assert.equal(deduped.document.files.length, 1);
  assert.throws(
    () =>
      mergeUpdateInfo([
        { document: { version, files: [{ url: x64, sha512: "a", size: 1 }] }, file: "a" },
        {
          document: { version: "3.13.0", files: [{ url: arm64, sha512: "b", size: 1 }] },
          file: "b",
        },
      ]),
    /version mismatch/,
  );
  assert.throws(() => mergeUpdateInfo([{ document: { files: [] }, file: "a" }]), /without version/);
  assert.throws(
    () => mergeUpdateInfo([{ document: { version, files: [{ url: x64, size: 1 }] }, file: "a" }]),
    /sha512/,
  );
});

async function artifactTree(t, flavors) {
  const root = await mkdtemp(join(tmpdir(), "nekcode-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const flavor of flavors) {
    for (const platform of ["linux", "win", "mac"]) {
      for (const arch of ["x64", "arm64"]) {
        const directory = join(root, `desktop-${flavor.flavor}-${platform}-${arch}`);
        await mkdir(directory, { recursive: true });
        const names = artifactNames(platform, version, arch, flavor);
        for (const name of names) await writeFile(join(directory, name), `artifact: ${name}`);
        // 每个 job 只描述自己那一份安装包，与真实 electron-builder 单架构输出一致。
        await writeFile(
          join(directory, sourceUpdateInfoName(platform, arch)),
          updateInfoYaml(names),
        );
      }
    }
  }
  return root;
}

test("assemble flattens installers and merges per-architecture update metadata", async (t) => {
  const preview = desktopProductIdentities.preview;
  const artifactsRoot = await artifactTree(t, [identity, preview]);
  const destination = await mkdtemp(join(tmpdir(), "nekcode-release-"));
  t.after(() => rm(destination, { recursive: true, force: true }));

  const written = await assembleReleaseAssets({
    artifactsRoot,
    destination,
    version,
    identities: [identity, preview],
  });
  assert.deepEqual(written, releaseUpdateInfoNames([identity, preview]));
  const entries = (await readdir(destination)).sort();
  assert.equal(entries.length, 28 + 8);

  const win = (await readUpdateInfo(join(destination, "latest.yml"))).document;
  assert.equal(win.version, version);
  assert.deepEqual(
    win.files.map((file) => file.url).sort(),
    [
      artifactNames("win", version, "arm64", identity)[0],
      artifactNames("win", version, "x64", identity)[0],
    ].sort(),
  );
  const previewWin = (await readUpdateInfo(join(destination, "latest-preview.yml"))).document;
  assert.deepEqual(
    previewWin.files.map((file) => file.url).sort(),
    [
      artifactNames("win", version, "arm64", preview)[0],
      artifactNames("win", version, "x64", preview)[0],
    ].sort(),
  );
  // Linux 的两份元数据保持按架构分离：arm64 走 latest-linux-arm64.yml。
  assert.deepEqual(
    (await readUpdateInfo(join(destination, "latest-linux-arm64.yml"))).document.files.map(
      (file) => file.url,
    ),
    artifactNames("linux", version, "arm64", identity),
  );
  // 组装结果必须能通过发布校验，并且只包含安装包 + 元数据 + SHA256SUMS。
  const files = await verifyReleaseAssets(destination, version, [identity, preview]);
  assert.equal(files.length, 37);
});

test("assemble refuses metadata that points at another platform's installer", async (t) => {
  const artifactsRoot = await artifactTree(t, [identity]);
  const destination = await mkdtemp(join(tmpdir(), "nekcode-release-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  await writeFile(
    join(artifactsRoot, "desktop-production-win-x64", "latest.yml"),
    updateInfoYaml([artifactNames("linux", version, "x64", identity)[0]]),
  );
  await assert.rejects(
    assembleReleaseAssets({ artifactsRoot, destination, version, identities: [identity] }),
    /unknown artifact/,
  );
});

test("release verification rejects update metadata with the wrong version or unknown file", async (t) => {
  const wrongVersion = await fixture(t);
  await writeFile(
    join(wrongVersion, "latest.yml"),
    updateInfoYaml(artifactNames("win", version, "x64", identity)).replace(version, "3.13.0"),
  );
  await assert.rejects(verifyReleaseAssets(wrongVersion, version, identity), /version/);

  const unknown = await fixture(t);
  await writeFile(join(unknown, "latest.yml"), updateInfoYaml(["nekcode-9.9.9-win-x64.exe"]));
  await assert.rejects(verifyReleaseAssets(unknown, version, identity), /unknown artifact/);

  const missing = await fixture(t);
  await rm(join(missing, "latest-mac.yml"));
  await assert.rejects(verifyReleaseAssets(missing, version, identity), { code: "ENOENT" });
});

function githubMock(releases = []) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    return {
      stdout:
        args[1] === "list"
          ? JSON.stringify(releases)
          : args[1] === "view"
            ? JSON.stringify({
                body: "Maintainer notes\n\n## Generated changes\n- Preserve this entry",
              })
            : "",
    };
  };
  return { run, calls };
}

test("draft title and notes describe both products without losing the required notice", async () => {
  const { run, calls } = githubMock();
  await publishDraft({ tag: "v3.14.0", repo: "owner/repo", files: ["/tmp/artifact"], run });
  const titleIndex = calls[1].indexOf("--title");
  assert.equal(calls[1][titleIndex + 1], "nekcode + nekcode-preview v3.14.0");
  const notesIndex = calls[1].indexOf("--notes");
  assert.match(calls[1][notesIndex + 1], /^To be, or not to be/);
  assert.match(
    calls[1][notesIndex + 1],
    /nekcode is the production desktop app.*nekcode-preview is the preview-channel build/s,
  );
  assert.match(calls[1][notesIndex + 1], /unsigned/i);
  assert.match(calls[1][notesIndex + 1], /Manual platform acceptance is not complete/);
});

test("create a draft then upload assets; never publish it", async () => {
  const { run, calls } = githubMock();
  await publishDraft({ tag: "v3.14.0", repo: "owner/repo", files: ["/tmp/artifact"], run });
  assert.equal(calls.length, 3);
  assert.ok(calls[1].includes("--draft"));
  assert.ok(calls[1].includes("--verify-tag"));
  const notesIndex = calls[1].indexOf("--notes");
  assert.notEqual(notesIndex, -1);
  assert.equal(
    calls[1][notesIndex + 1],
    "To be, or not to be, that is the question.\n\n生存还是毁灭，这是一个问题。\n\n— William Shakespeare, Hamlet / 莎士比亚《哈姆雷特》\n\nProducts: nekcode is the production desktop app; nekcode-preview is the preview-channel build and must not replace a production install.\n\nFeatures: nek CLI parity through the GUI RPC channel. Manual platform acceptance is not complete.\n\nmacOS arm64/x64, Linux x64/arm64 and Windows x64/arm64. Unsigned builds; review and test each platform before publishing. Verify downloads with SHA256SUMS.",
  );
  assert.equal(calls[2][2], "upload");
  assert.ok(calls[2].includes("--clobber"));
});

test("rerun updates only a draft and refuses an already public release", async () => {
  const draft = githubMock([{ tagName: "v3.14.0", isDraft: true }]);
  await publishDraft({ tag: "v3.14.0", repo: "owner/repo", files: ["a"], run: draft.run });
  assert.equal(draft.calls.length, 4);
  assert.equal(draft.calls[1][2], "view");
  assert.equal(draft.calls[2][2], "edit");
  assert.equal(
    draft.calls[2][draft.calls[2].indexOf("--title") + 1],
    "nekcode + nekcode-preview v3.14.0",
  );
  const updatedNotes = draft.calls[2][draft.calls[2].indexOf("--notes") + 1];
  assert.match(updatedNotes, /nekcode is the production desktop app/);
  assert.match(updatedNotes, /nekcode-preview is the preview-channel build/);
  assert.match(updatedNotes, /^Maintainer notes\n\n## Generated changes\n- Preserve this entry/);
  assert.equal(draft.calls[3][2], "upload");
  const published = githubMock([{ tagName: "v3.14.0", isDraft: false }]);
  await assert.rejects(
    publishDraft({ tag: "v3.14.0", repo: "owner/repo", files: ["a"], run: published.run }),
    /published/,
  );
  assert.equal(published.calls.length, 1);
});

test("draft metadata update failure stops before asset upload", async () => {
  const calls = [];
  await assert.rejects(
    publishDraft({
      tag: "v3.14.0",
      repo: "owner/repo",
      files: ["a"],
      run: async (_command, args) => {
        calls.push(args);
        if (args[1] === "list")
          return { stdout: JSON.stringify([{ tagName: "v3.14.0", isDraft: true }]) };
        if (args[1] === "view") return { stdout: JSON.stringify({ body: "notes" }) };
        throw new Error("metadata update failed");
      },
    }),
    /metadata update failed/,
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[2][1], "edit");
});

test("prerelease tags create prerelease drafts", async () => {
  const { run, calls } = githubMock();
  await publishDraft({ tag: "v3.14.0-ci.1", repo: "owner/repo", files: ["a"], run });
  assert.ok(calls[1].includes("--draft"));
  assert.ok(calls[1].includes("--prerelease"));
});

test("lookup failures stop before creating or modifying a release", async () => {
  let calls = 0;
  await assert.rejects(
    publishDraft({
      tag: "v3.14.0",
      repo: "owner/repo",
      files: ["a"],
      run: async () => {
        calls++;
        throw new Error("network unavailable");
      },
    }),
    /network unavailable/,
  );
  assert.equal(calls, 1);
});
