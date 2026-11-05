import { expect, test } from "vitest";
import {
  desktopMenuMessageIds,
  desktopMenuMessages,
  getDesktopMenuMessage,
} from "./desktopMenu.js";

test("B1: native menus use nekcode in both supported locales", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    for (const id of [
      desktopMenuMessageIds.helpAbout,
      desktopMenuMessageIds.trayTooltip,
      desktopMenuMessageIds.trayOpenZCode,
    ]) {
      expect(getDesktopMenuMessage(locale, id)).toContain("nekcode");
    }
    for (const text of Object.values(desktopMenuMessages[locale])) {
      expect(text).not.toMatch(/zcod(?:e|ium)/i);
    }
  }
});
