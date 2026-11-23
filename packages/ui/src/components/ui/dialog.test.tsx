// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "./dialog.js";

afterEach(cleanup);

it.each([
  { locale: "zh-CN", close: "关闭" },
  { locale: "en-US", close: "Close" },
] as const)("ZR-6 both Dialog close controls use the app language in $locale", (entry) => {
  render(
    <ZCodeIntlProvider initialLocale={entry.locale}>
      <Dialog open>
        <DialogContent>
          <DialogTitle>Fixture</DialogTitle>
          <DialogDescription>Dialog localization fixture</DialogDescription>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </ZCodeIntlProvider>,
  );

  const buttons = screen.getAllByRole("button", { name: entry.close });
  expect(buttons).toHaveLength(2);
  expect(buttons.some((button) => button.closest('[data-slot="dialog-footer"]'))).toBe(true);
  expect(buttons.some((button) => button.querySelector(".sr-only"))).toBe(true);
});
