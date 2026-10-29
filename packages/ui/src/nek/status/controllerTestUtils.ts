import { createElement, type PropsWithChildren } from "react";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

export function intlWrapper({ children }: PropsWithChildren) {
  return createElement(ZCodeIntlProvider, { initialLocale: "en-US", children });
}
