import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationDraftEmptyState } from "./ConversationDraftEmptyState.js";

it("ZR-9 sizes the draft greeting with the UI scale instead of a measured pixel size", () => {
  const html = renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US">
      <ConversationDraftEmptyState />
    </ZCodeIntlProvider>,
  );

  expect(html).toContain("text-ui-xl/[1.2]");
  expect(html).not.toContain("--v4-draft-greeting-font-size");
  expect(html).not.toContain("aria-hidden");
});
