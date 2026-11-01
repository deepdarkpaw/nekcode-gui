/** 设置验收：每页真实加载、截图，修改开关并核对隔离 settings.json。 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluate, screenshot, waitForPage } from "./cdp.mjs";
import { assertNoRendererFailure, clickAt, waitForSelector } from "./ui.mjs";

const SECTIONS = [
  "nekAccounts",
  "nekProviders",
  "nekDefaultModel",
  "nekCompaction",
  "nekTools",
  "nekMcp",
  "nekAgent",
  "nekProject",
  "nekRemoteHosts",
  "nekAppearance",
  "nekShortcuts",
  "nekAdvanced",
  "nekAbout",
];

export async function checkSettings(session, sandbox) {
  await clickAt(session, '[data-testid="task-settings-button"]');
  await waitForSelector(session, '[data-testid="settings-page"]', "settings page");
  for (const section of SECTIONS) {
    await clickAt(session, `[data-testid="settings-section-nav-${section}"]`);
    await waitForPage(
      session,
      `document.querySelector('[data-testid="settings-page"]')?.getAttribute('data-active-section') === '${section}'`,
      section,
    );
    await assertNoRendererFailure(session);
    await screenshot(session, join(sandbox.screenshots, `05-settings-${section}.png`));
    if (section === "nekCompaction") await checkCompactionWrite(session, sandbox);
  }
  await clickAt(session, '[data-testid="settings-back-button"]');
  await waitForSelector(session, '[data-testid="v4-composer-input"]', "composer after settings");
}

async function checkCompactionWrite(session, sandbox) {
  await waitForSelector(session, '[role="switch"]', "compaction auto switch");
  const selector = '[data-testid="settings-page"] [role="switch"]';
  const before = await evaluate(
    session,
    `document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-checked')`,
  );
  await clickAt(session, selector);
  const expected = before !== "true";
  await waitForPage(
    session,
    `document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-checked') === '${expected}'`,
    "compaction toggle acknowledged",
  );
  const path = join(sandbox.agentDir, "settings.json");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const settings = JSON.parse(await readFile(path, "utf8"));
    if (settings.compaction?.enabled === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`compaction.enabled did not persist as ${expected}`);
}
