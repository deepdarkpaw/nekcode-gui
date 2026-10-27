import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatErrorBanner } from "../../../packages/ui/src/ChatErrorBanner.js";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { PlatformProvider } from "../../../packages/ui/src/hooks/usePlatform.js";
const params = new URLSearchParams(location.search);
const locale = params.get("locale") || "en-US";
document.documentElement.classList.toggle("zai-light", params.get("theme") !== "dark");
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
document.documentElement.classList.toggle("zai-dark", params.get("theme") === "dark");
window.purchaseFixture = { configured: 0 };
const platform = {};
function Fixture() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <main className="min-h-screen bg-background text-foreground p-4 space-y-4">
      <ChatErrorBanner
        error={{ code: "MODEL_CONFIG_MISSING", message: "Internal model configuration path" }}
        onOpenModelSettings={() => {
          window.purchaseFixture.configured++;
          setSettingsOpen(true);
        }}
      />
      {settingsOpen ? (
        <section aria-label="Model settings">
          {locale === "zh-CN" ? "模型设置已打开" : "Model settings opened"}
        </section>
      ) : null}
    </main>
  );
}
createRoot(document.getElementById("root")).render(
  <PlatformProvider platform={platform}>
    <ZCodeIntlProvider initialLocale={locale}>
      <Fixture />
    </ZCodeIntlProvider>
  </PlatformProvider>,
);
