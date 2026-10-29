import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tsImport } from "tsx/esm/api";

const { resolveHelpAppConfig } = await tsImport(
  "../../packages/shared/src/helpAppConfig.ts",
  import.meta.url,
);
const { readDesktopHelpConfig } = await tsImport(
  "../../packages/desktop/src/main/desktopHelpConfig.ts",
  import.meta.url,
);
const bundled = JSON.parse(
  await readFile(new URL("../../config/default.json", import.meta.url), "utf8"),
);

test("help config is local, validates link protocols and preserves locale boundaries", () => {
  const local = resolveHelpAppConfig({
    community_urls: { "en-US": "https://example.com/community", "zh-CN": "javascript:alert(1)" },
  });
  assert.equal(local.community_urls["en-US"], "https://example.com/community");
  assert.equal(local.community_urls["zh-CN"], undefined);
});

test("Desktop packaged/development and Web help use the same bundled links without requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcodium-help-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("help network forbidden");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const resources = join(root, "resources");
  await mkdir(join(resources, "config"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  await writeFile(join(resources, "config/default.json"), JSON.stringify(bundled));
  await writeFile(join(root, "config/default.json"), JSON.stringify(bundled));
  const expected = resolveHelpAppConfig(bundled);
  assert.deepEqual(
    await readDesktopHelpConfig({
      isPackaged: true,
      appPath: join(resources, "app.asar"),
      resourcesPath: resources,
    }),
    expected,
  );
  assert.deepEqual(
    await readDesktopHelpConfig({
      isPackaged: false,
      appPath: join(root, "packages/desktop"),
      resourcesPath: resources,
    }),
    expected,
  );
  assert.equal(expected.community_urls["en-US"], "https://github.com/axiom-desu/ZCodium");
  await writeFile(join(resources, "config/default.json"), "malformed");
  await assert.rejects(
    readDesktopHelpConfig({ isPackaged: true, appPath: "unused", resourcesPath: resources }),
  );
});
