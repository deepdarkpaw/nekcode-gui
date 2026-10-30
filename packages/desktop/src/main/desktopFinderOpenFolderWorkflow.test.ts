import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installFinderOpenFolderWorkflow } from "./desktopFinderOpenFolderWorkflow.js";

const WORKFLOW_DIR_NAME = "Open in ZCode.workflow";
const temporaryHomes: string[] = [];

async function createTemporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "finder-workflow-"));
  temporaryHomes.push(home);
  return home;
}

function install(options: { homeDir: string; locale: "zh-CN" | "en-US" }) {
  const logs: string[] = [];
  installFinderOpenFolderWorkflow({
    platform: "darwin",
    locale: options.locale,
    homeDir: options.homeDir,
    logger: {
      info: (message) => logs.push(String(message)),
      warn: (message) => logs.push(String(message)),
    },
    refreshServicesIndex: () => {},
  });
  return logs;
}

function infoPlistPath(homeDir: string): string {
  return join(homeDir, "Library", "Services", WORKFLOW_DIR_NAME, "Contents", "Info.plist");
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe("installFinderOpenFolderWorkflow", () => {
  it("Finder 服务菜单项使用 nekcode 品牌", async () => {
    const homeDir = await createTemporaryHome();

    install({ homeDir, locale: "zh-CN" });
    const chinesePlist = await readFile(infoPlistPath(homeDir), "utf8");
    expect(chinesePlist).toContain("<string>在nekcode中打开</string>");
    expect(chinesePlist).not.toContain("在ZCode中打开");

    install({ homeDir, locale: "en-US" });
    const englishPlist = await readFile(infoPlistPath(homeDir), "utf8");
    expect(englishPlist).toContain("<string>Open in nekcode</string>");
    expect(englishPlist).not.toContain("Open in ZCode");
  });
});
