import { expect, it, vi } from "vitest";
import { createQuickPickCommands } from "./quickPickCommands.js";

it("ZR-7 exposes a single general settings command in Configure", async () => {
  const openSettings = vi.fn();
  const noop = () => undefined;
  const commands = createQuickPickCommands({
    allowOpenWorkspace: true,
    isSidebarVisible: true,
    themeTarget: "dark",
    shortcuts: { newTask: "", openWorkspace: "", toggleSidebar: "", toggleTerminal: "" },
    handlers: {
      createTask: noop,
      openWorkspace: noop,
      openSettings,
      openSkillsSettings: noop,
      openMcpSettings: noop,
      switchTheme: noop,
      openProductDocs: noop,
      toggleSidebar: noop,
      toggleTerminal: noop,
      openTerminalTab: noop,
      openReviewTab: noop,
    },
  });

  const settings = commands.filter(
    (command) => command.titleId === "quickPick.command.settings" || command.run === openSettings,
  );
  expect(settings).toMatchObject([{ id: "settings", sectionId: "configure" }]);
  await settings[0]!.run();
  expect(openSettings).toHaveBeenCalledOnce();
});
