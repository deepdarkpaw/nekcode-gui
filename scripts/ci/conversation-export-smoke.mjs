import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "../..");
const { outputFiles } = await build({
  entryPoints: [resolve(import.meta.dirname, "fixtures/conversation-export.jsx")],
  bundle: true,
  write: false,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  alias: { "@": resolve(root, "packages/ui/src") },
  outdir: resolve(root, ".tmp/task-archive-export-fixture"),
  loader: { ".css": "empty", ".png": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
});
const script = outputFiles.find((file) => file.path.endsWith(".js")).contents;
let css = "";
// CI 可只跑行为检查；本地人工视觉走查使用真实桌面构建的样式。
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
    return;
  }
  if (request.url === "/styles.css") {
    response.setHeader("Content-Type", "text/css");
    response.end(css);
    return;
  }
  if (request.url?.startsWith("/assets/")) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end(
    '<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/styles.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.ZCODE_TEST_CHROMIUM_EXECUTABLE || undefined,
  });
  const page = await browser.newPage();
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.continue();
    requests.push(route.request().url());
    return route.abort();
  });
  for (const locale of ["zh-CN", "en-US"]) {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 850 });
      for (const outcome of ["cancel", "failure", "download"]) {
        await page.goto(
          `http://127.0.0.1:${server.address().port}/?locale=${locale}&outcome=${outcome}`,
        );
        const title = page.getByRole("textbox");
        await title.fill("My selected conversation");
        assert.equal(await page.getByRole("checkbox").count(), 0);
        assert.equal(await page.getByRole("combobox").count(), 0);
        const confirm = page.getByTestId("conversation-share-confirm");
        await title.press("Tab");
        assert.ok(await confirm.evaluate((element) => document.activeElement === element));
        if (process.env.ZCODE_TEST_SCREENSHOT_DIR && outcome === "cancel") {
          await page.screenshot({
            path: resolve(
              process.env.ZCODE_TEST_SCREENSHOT_DIR,
              `export-confirm-${locale}-${width}.png`,
            ),
          });
        }
        let download;
        if (outcome === "download") {
          const waitDownload = page.waitForEvent("download");
          await page.keyboard.press("Enter");
          download = await waitDownload;
          assert.equal(download.suggestedFilename(), "conversation-report.nekcode");
          const data = await readFile(await download.path());
          assert.deepEqual([...data], [80, 75, 0, 255, 1, 2, 3]);
        } else {
          await page.keyboard.press("Enter");
          await page.waitForFunction(() => window.exportCalls.releases === 1);
          assert.equal(await page.getByTestId("conversation-share-success-dock").count(), 0);
          if (outcome === "cancel")
            assert.equal(await title.inputValue(), "My selected conversation");
          else await page.getByRole("alert").waitFor();
          await confirm.click();
        }
        await page.getByTestId("conversation-share-success-dock").waitFor();
        assert.equal(await page.getByTestId("conversation-share-copy-link").count(), 0);
        assert.equal(await page.getByTestId("conversation-share-open-browser").count(), 0);
        assert.equal(
          await page.getByTestId("conversation-share-result-title").innerText(),
          outcome === "download" ? "conversation-report.nekcode" : "renamed-by-user.nekcode",
        );
        const calls = await page.evaluate(() => window.exportCalls);
        assert.equal(calls.saves, outcome === "download" ? 1 : 2);
        assert.equal(calls.releases, calls.saves);
        const status = await page.getByTestId("conversation-share-success-status").innerText();
        assert.match(
          status,
          outcome === "download" ? /已开始下载|Download started/ : /文件已保存|File saved/,
        );
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (process.env.ZCODE_TEST_SCREENSHOT_DIR)
          await page.screenshot({
            path: resolve(
              process.env.ZCODE_TEST_SCREENSHOT_DIR,
              `export-${locale}-${width}-${outcome}.png`,
            ),
          });
        await page.getByTestId("conversation-share-success-dismiss").click();
        await page.getByText("Closed", { exact: true }).waitFor();
      }
      // Before any save, Back/Cancel returns without invoking the platform.
      await page.goto(`http://127.0.0.1:${server.address().port}/?locale=${locale}`);
      await page
        .getByRole("button", { name: locale === "zh-CN" ? "取消" : "Cancel", exact: true })
        .click();
      assert.equal((await page.evaluate(() => window.exportCalls)).saves, 0);
    }
  }
  const url = `http://127.0.0.1:${server.address().port}/?native=1`;
  const trigger = page.getByTestId("task-archive-export-trigger");
  const dialog = page.getByTestId("task-archive-export-confirmation");
  const result = () => page.evaluate(() => window.archiveCalls);
  const waitEnabled = () =>
    page.waitForFunction(
      () => !document.querySelector('[data-testid="task-archive-export-trigger"]')?.disabled,
    );
  for (const locale of ["zh-CN", "en-US"]) {
    const zh = locale === "zh-CN";
    const confirm = dialog.getByRole("button", { name: zh ? /继续导出/u : /Continue to export/u });
    const retry = page.getByRole("button", { name: zh ? "重试" : "Retry", exact: true });
    for (const width of [390, 1280]) {
      const theme = width === 1280 ? "dark" : "light";
      const remote = width === 1280 ? 1 : 0;
      await page.setViewportSize({ width, height: 850 });
      for (const outcome of ["cancel", "save-failure", "download", "locked", "read-failure"]) {
        await page.goto(
          `${url}&locale=${locale}&theme=${theme}&remote=${remote}&outcome=${outcome}`,
        );
        await trigger.press("Enter");
        await dialog.waitFor();
        const disclosure = await dialog.innerText();
        assert.match(disclosure, /JSONL/u);
        assert.match(disclosure, /未经脱敏|Nothing is redacted/u);
        assert.match(disclosure, /外部附件只保留引用|External attachments are referenced/u);
        assert.deepEqual((await result()).actions, []);
        if (outcome === "cancel") {
          if (process.env.ZCODE_TEST_SCREENSHOT_DIR)
            await page.screenshot({
              path: resolve(
                process.env.ZCODE_TEST_SCREENSHOT_DIR,
                `NA-export-confirm-${locale}-${theme}.png`,
              ),
              animations: "disabled",
            });
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
          await waitEnabled();
          assert.deepEqual((await result()).actions, []);
          await trigger.click();
          await dialog.waitFor();
        }
        const download = outcome === "download" ? page.waitForEvent("download") : undefined;
        await confirm.click();
        if (download) {
          const file = await download;
          assert.equal(file.suggestedFilename(), "task-fixture.jsonl");
          assert.equal(await readFile(await file.path(), "utf8"), (await result()).nativeText);
          await page
            .getByText(zh ? "已开始下载任务归档" : "Task archive download started", { exact: true })
            .waitFor();
        }
        if (outcome === "locked" || outcome === "read-failure") {
          await page
            .getByText(
              outcome === "locked"
                ? /另一个进程锁定|Another process has locked/u
                : /任务导出失败|Task export failed/u,
            )
            .waitFor();
          await waitEnabled();
          const calls = await result();
          assert.deepEqual(calls.saves, []);
          assert.ok(calls.actions.every((entry) => entry.host === (remote ? "ssh-A" : "local")));
          assert.deepEqual(
            calls.actions.map((entry) => entry.action),
            outcome === "locked" ? ["export"] : ["export", "readExport", "release"],
          );
          continue;
        }
        if (outcome === "cancel" || outcome === "save-failure") {
          await page.waitForFunction(() => window.archiveCalls.saves.length === 1);
          await waitEnabled();
          assert.equal(
            await page
              .getByText(zh ? "任务归档已保存" : "Task archive saved", { exact: true })
              .count(),
            0,
          );
          if (outcome === "cancel") await trigger.click();
          else {
            await page
              .getByText(zh ? /检查权限和可用空间/u : /Check permissions and available disk space/u)
              .waitFor();
            await retry.click();
          }
          await confirm.click();
          await page
            .getByText(zh ? "任务归档已保存" : "Task archive saved", { exact: true })
            .waitFor();
        }
        const calls = await result();
        assert.equal(calls.saves.length, outcome === "download" ? 1 : 2);
        assert.equal(
          calls.actions.filter((entry) => entry.action === "release").length,
          calls.saves.length,
        );
        for (const saved of calls.saves)
          assert.deepEqual(saved, {
            name: "task-fixture.jsonl",
            text: calls.nativeText,
            after: "release",
          });
        assert.ok(calls.actions.every((entry) => entry.host === (remote ? "ssh-A" : "local")));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    }
  }
  await page.goto(`${url}&locale=en-US&remote=1&outcome=read-switch`);
  await trigger.click();
  await dialog.getByRole("button", { name: /Continue to export/u }).click();
  await page.waitForFunction(() => window.archiveCalls.pending.length === 1);
  await page.evaluate(() => {
    window.switchArchiveTask();
    window.archiveCalls.pending[0]();
  });
  await page.getByText(/The task or project changed/u).waitFor();
  assert.deepEqual((await result()).saves, []);
  assert.deepEqual(
    (await result()).actions.map((entry) => [entry.host, entry.action]),
    [
      ["ssh-A", "export"],
      ["ssh-A", "readExport"],
      ["ssh-A", "release"],
    ],
  );

  await page.goto(`${url}&locale=en-US&draft=1`);
  const slash = page.getByRole("textbox", { name: "Slash command" });
  await slash.fill("/export");
  await slash.press("Enter");
  await page.getByText("Open a task with messages before exporting an archive.").waitFor();
  assert.equal(await trigger.count(), 0);
  assert.deepEqual((await result()).actions, []);

  await page.goto(`${url}&locale=en-US`);
  await slash.fill("/export another.html");
  await slash.press("Enter");
  await page.getByText("/export does not take arguments.", { exact: false }).waitFor();
  assert.deepEqual((await result()).actions, []);
  await slash.fill("/export");
  await slash.press("Enter");
  await dialog.getByRole("button", { name: /Continue to export/u }).click();
  await page.getByText("Task archive saved", { exact: true }).waitFor();
  assert.equal((await result()).slash.status, "sent");

  assert.deepEqual(errors, []);
  assert.deepEqual(requests, []);
  console.log(
    "NA export browser smoke passed: 23 native scenarios plus historical save-helper coverage, zh/en, dark/light, SSH and local, warnings, cancel, retry, byte equality, task changes and /export; no external requests.",
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
