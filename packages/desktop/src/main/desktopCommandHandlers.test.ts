import { DesktopCommandIds, type DesktopCommandId, type Locale } from "@zcode/shared";
import { shell } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { resolveGithubReleasesUrl } from "../../scripts/desktop-product-identity.mjs";
import { executeDesktopCommand } from "./desktopCommandHandlers.js";

vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
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
