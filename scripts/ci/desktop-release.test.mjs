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
  readUpdateInfo,
  releaseUpdateInfoNames,
  resolveReleasePlatforms,
  sourceUpdateInfoName,
  updateInfoChannelName,
  validateTag,
  verifyReleaseAssets,
} from "./desktop-release.mjs";
import { releaseNotes } from "./desktop-release-publish.mjs";
import { desktopProductIdentities } from "../../packages/desktop/scripts/desktop-product-identity.mjs";
import { collectRollingAppVersion } from "../rolling-app-version.mjs";

const version = "3.14.0";
// 产物名改由构建期产品身份派生（bugfix：曾硬编码 `ZCodium-`，身份改为 `ZCodium Exp`
// 后 CI 的 Build job 全部 ENOENT）。这里显式取 production 身份，使断言不依赖运行环境的
// ZCODE_ENV / ZCODE_PREVIEW_IDENTITY——CI 设了 production，本机裸跑会解析成 Preview。
const identity = desktopProductIdentities.production;
const allNames = [
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
  // 不发布 Linux 桌面包：Linux 只作为 SSH 远程主机。
  assert.throws(() => artifactNames("linux", version), /Unsupported platform/);
});

test("rolling app version is stable for the same checked-out commit", () => {
  assert.deepEqual(collectRollingAppVersion(), collectRollingAppVersion());
});

// tag 只标识上游基线（v3.14.4），产物名带的是构建期滚动版本串（#38 起 electron-builder
// 用 extraMetadata.version 命名）。collect 与 publish 的 verifyReleaseAssets 都必须按滚动串
// 匹配，否则 tag 一发就按基线名找不到产物。这里钉住 artifactNames 对 prerelease 串可用。
test("artifact names accept the rolling prerelease build version", () => {
  const rolling = "3.14.4-20261009.258";
  assert.equal(artifactNames("win", rolling, "x64", identity)[0], `nekcode-${rolling}-win-x64.exe`);
  assert.notEqual(
    artifactNames("win", rolling, "x64", identity)[0],
    artifactNames("win", "3.14.4", "x64", identity)[0],
  );
});

test("collect copies the platform installers with their update metadata and nothing else", async (t) => {
  const source = await fixture(t);
  const output = await fixture(t, []);
  await collectArtifacts(source, output, "mac", version, "arm64", identity);
  const macArm64 = artifactNames("mac", version, "arm64", identity);
  assert.deepEqual((await readdir(output)).sort(), [...macArm64, "latest-mac.yml"].sort());
  assert.equal(await readFile(join(output, macArm64[0]), "utf8"), `artifact: ${macArm64[0]}`);
  // 其他平台、其他架构及其更新元数据不得混入同一个 job 的产物集合。
  await assert.rejects(readFile(join(output, artifactNames("win", version, "x64", identity)[0])), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(join(output, artifactNames("mac", version, "x64", identity)[0])), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(join(output, sourceUpdateInfoName("win", "x64"))), {
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
    ...artifactNames("win", version, "x64", identity),
    ...artifactNames("win", version, "x64", preview),
  ]);
  const output = await fixture(t, []);
  await collectArtifacts(source, output, "win", version, "x64", preview);
  assert.deepEqual(
    (await readdir(output)).sort(),
    [...artifactNames("win", version, "x64", preview), "latest.yml"].sort(),
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

test("dual-product checksums cover exactly 12 installers from both identities", async (t) => {
  const preview = desktopProductIdentities.preview;
  const names = [
    ...artifactNames("win", version, undefined, identity),
    ...artifactNames("mac", version, undefined, identity),
    ...artifactNames("win", version, undefined, preview),
    ...artifactNames("mac", version, undefined, preview),
  ];
  const directory = await fixture(t, names, [identity, preview]);
  const paths = await verifyReleaseAssets(directory, version, [identity, preview]);
  // 12 个安装包 + 4 份更新元数据（Windows/macOS × 两身份，两个架构合并）+ SHA256SUMS
  assert.equal(paths.length, 17);
  assert.equal(
    (await readFile(join(directory, "SHA256SUMS"), "utf8")).trim().split("\n").length,
    12,
  );
});

test("dual-product verification rejects empty, duplicate, missing, empty, wrong-version, and extra inputs", async (t) => {
  const preview = desktopProductIdentities.preview;
  const names = [
    ...artifactNames("win", version, undefined, identity),
    ...artifactNames("mac", version, undefined, identity),
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

test("checksums cover exactly the six validated installers and can be regenerated", async (t) => {
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
  assert.equal(paths.length, 9);
  await verifyReleaseAssets(directory, version, identity);
});

test("update metadata filenames follow electron-updater channel rules", () => {
  // electron-updater 的 Provider#getChannelFilePrefix：Windows 无平台后缀，macOS 追加 -mac。
  assert.equal(updateInfoChannelName("win", "production", "x64"), "latest.yml");
  assert.equal(updateInfoChannelName("win", "production", "arm64"), "latest.yml");
  assert.equal(updateInfoChannelName("win", "preview", "x64"), "latest-preview.yml");
  assert.throws(() => updateInfoChannelName("linux", "production", "x64"), /Unsupported platform/);
  assert.equal(updateInfoChannelName("mac", "production", "arm64"), "latest-mac.yml");
  assert.equal(updateInfoChannelName("mac", "preview", "x64"), "latest-preview-mac.yml");
  // electron-builder 写盘用的是 latest 通道名，与生产身份的 canonical 名同源。
  assert.equal(sourceUpdateInfoName("win", "arm64"), "latest.yml");
  assert.throws(() => updateInfoChannelName("freebsd", "production", "x64"));
  assert.throws(() => updateInfoChannelName("win", "production", "riscv64"));
  assert.deepEqual(releaseUpdateInfoNames([identity]), ["latest-mac.yml", "latest.yml"]);
  assert.equal(releaseUpdateInfoNames([identity, desktopProductIdentities.preview]).length, 4);
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
  assert.equal(merged.version, version);
  assert.deepEqual(
    merged.files.map((file) => file.url),
    [x64, arm64],
  );
  assert.equal(merged.path, x64);
  assert.equal(merged.sha512, "a");
  assert.equal(merged.releaseDate, "2026-01-02T00:00:00.000Z");
  // 重复 url 只保留一份（同一架构被收集两次时不能让 files[] 出现重复项）。
  const deduped = mergeUpdateInfo([
    { document: { version, files: [{ url: x64, sha512: "a", size: 1 }] }, file: "a/latest.yml" },
    { document: { version, files: [{ url: x64, sha512: "a", size: 1 }] }, file: "b/latest.yml" },
  ]);
  assert.equal(deduped.files.length, 1);
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
    for (const platform of ["win", "mac"]) {
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
  assert.equal(entries.length, 12 + 4);

  const win = (await readUpdateInfo(join(destination, "latest.yml"))).document;
  assert.equal(win.version, version);
  // x64 在前：兼容字段 path/sha512 指向 x64 主下载产物（不是按目录名字母序排在前面的 arm64）。
  const winX64 = artifactNames("win", version, "x64", identity)[0];
  assert.deepEqual(
    win.files.map((file) => file.url),
    [winX64, artifactNames("win", version, "arm64", identity)[0]],
  );
  assert.equal(win.path, winX64);
  assert.equal(win.sha512, win.files[0].sha512);
  const mac = (await readUpdateInfo(join(destination, "latest-mac.yml"))).document;
  assert.match(mac.path, /-mac-x64\.(?:dmg|zip)$/);
  const previewWin = (await readUpdateInfo(join(destination, "latest-preview.yml"))).document;
  assert.deepEqual(
    previewWin.files.map((file) => file.url).sort(),
    [
      artifactNames("win", version, "arm64", preview)[0],
      artifactNames("win", version, "x64", preview)[0],
    ].sort(),
  );
  // 组装结果必须能通过发布校验，并且只包含安装包 + 元数据 + SHA256SUMS。
  const files = await verifyReleaseAssets(destination, version, [identity, preview]);
  assert.equal(files.length, 17);
});

test("assemble publishes a Windows-only release when macOS artifacts are absent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nekcode-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const arch of ["x64", "arm64"]) {
    const directory = join(root, `desktop-${identity.flavor}-win-${arch}`);
    await mkdir(directory, { recursive: true });
    const names = artifactNames("win", version, arch, identity);
    for (const name of names) await writeFile(join(directory, name), `artifact: ${name}`);
    await writeFile(join(directory, sourceUpdateInfoName("win", arch)), updateInfoYaml(names));
  }
  const destination = await mkdtemp(join(tmpdir(), "nekcode-release-"));
  t.after(() => rm(destination, { recursive: true, force: true }));

  const written = await assembleReleaseAssets({
    artifactsRoot: root,
    destination,
    version,
    identities: [identity],
  });
  // 没有 mac 产物时只合并 Windows 的更新元数据，不能凭空写一份 latest-mac.yml。
  assert.deepEqual(written, ["latest.yml"]);
  const files = await verifyReleaseAssets(destination, version, [identity]);
  assert.equal(files.length, 1 + 3);
  assert.deepEqual(resolveReleasePlatforms(destination, version, [identity]), ["win"]);
  assert.throws(
    () => releaseNotes({ productName: "nekcode", version, platforms: ["linux"] }),
    /Unsupported release platform/,
  );
  assert.doesNotMatch(
    releaseNotes({
      productName: "nekcode",
      version,
      platforms: resolveReleasePlatforms(destination, version, [identity]),
    }),
    /macOS|dmg/,
  );
});

test("assemble refuses metadata that points at another platform's installer", async (t) => {
  const artifactsRoot = await artifactTree(t, [identity]);
  const destination = await mkdtemp(join(tmpdir(), "nekcode-release-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  await writeFile(
    join(artifactsRoot, "desktop-production-win-x64", "latest.yml"),
    updateInfoYaml([artifactNames("mac", version, "x64", identity)[0]]),
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
