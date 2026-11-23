import { DesktopCommandIds, type DesktopCommandId, type Locale } from "@zcode/shared";
import { app, dialog, shell } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { resolveGithubReleasesUrl } from "../../scripts/desktop-product-identity.mjs";
import { executeDesktopCommand } from "./desktopCommandHandlers.js";

vi.mock("electron", () => ({
  app: { relaunch: vi.fn(), exit: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
vi.mock("@zcode/services/node", () => ({}));
vi.mock("./about.js", () => ({}));
vi.mock("./autoUpdater.js", () => ({}));
vi.mock("./exportLogs.js", () => ({}));
vi.mock("./resourceManagerWindow.js", () => ({}));

function createCommandOptions(command: DesktopCommandId, locale: Locale) {
  return {
    command,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    updateZCodeStdioTapDevMenuState: vi.fn(),
    onZCodeEndpointChanged: vi.fn(),
    onRelaunchApp: vi.fn(),
    settingService: { get: vi.fn(async () => ({})), update: vi.fn() },
    credentialsDir: "unused-test-path",
    currentApplicationLocale: locale,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each(["zh-CN", "en-US"] as const)(
  "ZR-2 opens the GitHub Releases page in %s",
  async (locale) => {
    const options = createCommandOptions(DesktopCommandIds.OpenChangelog, locale);

    await executeDesktopCommand(options);

    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://github.com/deepdarkpaw/nekcode-gui/releases",
    );
    expect(options.settingService.get).not.toHaveBeenCalled();
  },
);

it("ZR-2 follows the packaged update identity when a fork builds the app", async () => {
  const url = resolveGithubReleasesUrl({
    NEKCODE_UPDATE_OWNER: " fork ",
    NEKCODE_UPDATE_REPO: "gui",
  });
  vi.stubGlobal("__NEKCODE_GITHUB_RELEASES_URL__", url);

  await executeDesktopCommand(createCommandOptions(DesktopCommandIds.OpenChangelog, "en-US"));

  expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith(
    "https://github.com/fork/gui/releases",
  );
});

it.each([
  {
    locale: "zh-CN",
    buttons: ["取消", "清除所有数据"],
    title: "清除所有数据",
    message: "确定要清除所有数据吗？",
    detail:
      "将删除 ~/.nek/gui/v2 中的配置、凭据、日志，以及应用的浏览器存储（含 localStorage）。此操作无法撤销，清除后应用会自动重启。",
  },
  {
    locale: "en-US",
    buttons: ["Cancel", "Clear all data"],
    title: "Clear all data",
    message: "Are you sure you want to clear all data?",
    detail:
      "This deletes settings, credentials, and logs in ~/.nek/gui/v2, as well as the app's browser storage (including localStorage). This cannot be undone. The app will restart automatically.",
  },
] as const)("ZR-3 localizes the entire clear data confirmation in $locale", async (entry) => {
  vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });

  await executeDesktopCommand(createCommandOptions(DesktopCommandIds.ClearAllData, entry.locale));

  expect(dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith({
    type: "warning",
    defaultId: 0,
    cancelId: 0,
    buttons: entry.buttons,
    title: entry.title,
    message: entry.message,
    detail: entry.detail,
  });
  expect(app.relaunch).not.toHaveBeenCalled();
  expect(app.exit).not.toHaveBeenCalled();
});
