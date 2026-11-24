import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const { outputFiles } = await build({
  entryPoints: [resolve(import.meta.dirname, "fixtures/conversation-import.jsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: { "@": resolve(root, "packages/ui/src") },
  outdir: resolve(root, ".tmp/task-archive-import-fixture"),
  loader: { ".css": "empty", ".png": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
});
const script = outputFiles.find((file) => file.path.endsWith(".js")).contents;
let css = "";
if (process.env.ZCODE_TEST_RENDERER_ASSETS) {
  const directory = process.env.ZCODE_TEST_RENDERER_ASSETS;
  const file = (await readdir(directory)).find((name) => /^styles-.*\.css$/.test(name));
  assert.ok(file, "Desktop production CSS must exist for visual walkthrough");
  css = await readFile(resolve(directory, file), "utf8");
}
const server = createServer((request, response) => {
  if (request.url === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(script);
  } else if (request.url === "/styles.css") {
    response.setHeader("Content-Type", "text/css");
    response.end(css);
  } else if (request.url?.startsWith("/assets/")) {
    response.writeHead(404).end();
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end(
      '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
    );
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}/`;
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const page = await browser.newPage();
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  const calls = () => page.evaluate(() => window.archiveCalls);
  // File input is removed before the control releases its busy state; wait on the actual button.
  const waitEnabled = (label) =>
    page.waitForFunction(
      (name) =>
        [...document.querySelectorAll("button")].some(
          (button) => button.getAttribute("aria-label") === name && !button.disabled,
        ),
      label,
    );
  const choose = async (menu, action, { keyboard = false } = {}) => {
    if (keyboard) await menu.press("Enter");
    else await menu.click();
    const chooser = page.waitForEvent("filechooser");
    if (keyboard) await action.press("Enter");
    else await action.click();
    return await chooser;
  };
  const setFile = async (chooser, outcome = "success") =>
    chooser.setFiles({
      name: outcome === "legacy" ? "previous.nekcode" : "native.JSONL",
      mimeType: "application/octet-stream",
      buffer:
        outcome === "legacy"
          ? Buffer.from([80, 75, 3, 4])
          : Buffer.from((await calls()).nativeText),
    });
  const screenshot = async (name) => {
    if (process.env.ZCODE_TEST_SCREENSHOT_DIR) {
      await page.screenshot({
        path: resolve(process.env.ZCODE_TEST_SCREENSHOT_DIR, name),
        animations: "disabled",
      });
    }
  };
  for (const locale of ["zh-CN", "en-US"]) {
    const zh = locale === "zh-CN";
    const menuName = zh ? "任务选项" : "Task options";
    const menu = page.getByRole("button", { name: menuName });
    const action = page.getByRole("menuitem", {
      name: zh ? "从 JSONL 导入任务…" : "Import task from JSONL…",
    });
    const retry = page.getByRole("button", { name: zh ? "重试" : "Retry", exact: true });
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 850 });
      const theme = width === 1280 ? "dark" : "light";
      for (const outcome of [
        "success",
        "failure",
        "corrupt",
        "legacy",
        "unknown",
        "disconnected",
        "unavailable",
      ]) {
        const target = width === 1280 || outcome === "disconnected" ? "1" : "0";
        await page.goto(
          `${url}?locale=${locale}&outcome=${outcome}&theme=${theme}&remote=${target}`,
        );
        if (outcome === "unavailable") {
          await page.getByRole("button", { name: zh ? /^新建任务/u : /^New task/u }).waitFor();
          assert.equal(await menu.count(), 0);
          continue;
        }
        if (outcome === "disconnected") {
          await menu.click();
          await action.click();
          await page
            .getByText(zh ? "当前项目不可用。" : "The current project is unavailable.", {
              exact: false,
            })
            .waitFor();
          assert.equal((await calls()).actions.length, 0);
          continue;
        }
        if (outcome === "success") {
          await menu.press("Enter");
          await action.waitFor();
          await screenshot(`NA-import-menu-${locale}-${theme}.png`);
          const picker = page.waitForEvent("filechooser");
          await action.press("Enter");
          await picker;
          await page
            .locator('input[type="file"]')
            .evaluate((element) => element.dispatchEvent(new Event("cancel")));
          await waitEnabled(menuName);
          assert.equal((await calls()).actions.length, 0);
        }
        await setFile(await choose(menu, action), outcome);
        if (outcome === "legacy" || outcome === "corrupt" || outcome === "unknown") {
          const text =
            outcome === "legacy"
              ? /旧版 \.nekcode|Legacy \.nekcode/u
              : outcome === "corrupt"
                ? /无效|不是有效|not a valid/u
                : /无法确认导入|Could not confirm the import/u;
          await page.getByText(text).waitFor();
          await waitEnabled(menuName);
          const { actions, opened } = await calls();
          assert.equal(await retry.count(), 0);
          assert.deepEqual(opened, []);
          assert.deepEqual(
            actions.map((entry) => entry.action),
            outcome === "legacy" ? [] : ["beginImport", "appendImport", "import", "release"],
          );
          continue;
        }
        if (outcome === "failure") {
          await retry.waitFor();
          await screenshot(`NA-import-retry-${locale}-${theme}.png`);
          assert.ok((await calls()).actions.every((entry) => entry.action !== "import"));
          const next = page.waitForEvent("filechooser");
          await retry.click();
          await setFile(await next);
        }
        await page.getByTestId("opened-native-task").waitFor();
        await waitEnabled(menuName);
        const result = await calls();
        assert.equal(result.opened.length, 1);
        assert.equal(result.uploaded, result.nativeText);
        assert.equal(result.actions.filter((entry) => entry.action === "import").length, 1);
        assert.equal(
          result.actions.filter((entry) => entry.action === "release").length,
          outcome === "failure" ? 2 : 1,
        );
        for (const entry of result.actions) {
          assert.equal(entry.host, target === "1" ? "ssh-A" : "local");
          assert.equal(entry.workspacePath, "/fixture/workspace");
          assert.equal(
            entry.workspaceIdentity,
            target === "1" ? "ssh-fixture:/fixture/workspace" : undefined,
          );
        }
        assert.equal(await page.locator('input[type="file"]').count(), 0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    }
  }

  const switchMenu = page.getByRole("button", { name: "Task options" });
  const switchAction = page.getByRole("menuitem", { name: "Import task from JSONL…" });
  for (const outcome of ["upload-switch", "switch"]) {
    await page.goto(`${url}?locale=en-US&remote=1&outcome=${outcome}`);
    await setFile(await choose(switchMenu, switchAction));
    await page.waitForFunction(() => window.archiveCalls.pending.length === 1);
    await page.evaluate(() => {
      window.replaceArchiveHost();
      window.archiveCalls.pending[0]();
    });
    await waitEnabled("Task options");
    assert.deepEqual((await calls()).opened, []);
    assert.deepEqual(
      (await calls()).actions.map((entry) => [entry.host, entry.action]),
      [
        ["ssh-A", "beginImport"],
        ["ssh-A", "appendImport"],
        ...(outcome === "switch" ? [["ssh-A", "import"]] : []),
        ["ssh-A", "release"],
      ],
    );
    await setFile(await choose(switchMenu, switchAction));
    await page.waitForFunction(() => window.archiveCalls.pending.length === 2);
    await page.evaluate(() => window.archiveCalls.pending[1]());
    assert.match(await page.getByTestId("opened-native-task").innerText(), /^imported-ssh-B-/u);
  }

  await page.goto(`${url}?locale=en-US&draft=1`);
  const slash = page.getByRole("textbox", { name: "Slash command" });
  await slash.fill("/import archive.jsonl");
  await slash.press("Enter");
  await page.getByText("/import does not take arguments.", { exact: false }).waitFor();
  assert.equal((await calls()).actions.length, 0);
  await slash.fill("/import");
  const slashPicker = page.waitForEvent("filechooser");
  await slash.press("Enter");
  await setFile(await slashPicker);
  await page.getByTestId("opened-native-task").waitFor();
  assert.equal((await calls()).slash.status, "sent");
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    "NA import browser smoke passed: zh/en, narrow/light and wide/dark, local/SSH routes, keyboard/picker cancel, retry before commit, legacy/corrupt files, unknown commit, host change and /import (31 cases; no external requests).",
  );
} catch (error) {
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages()) console.error(await page.locator("body").innerText());
  throw error;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
