import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationShareConfirmationDock } from "../../../packages/ui/src/v4/ConversationShareConfirmationDock.js";
import { ConversationShareSuccessDock } from "../../../packages/ui/src/v4/ConversationShareSuccessDock.js";
import { saveConversationExport } from "../../../packages/ui/src/lib/saveConversationExport.js";
import { ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { PlatformProvider } from "../../../packages/ui/src/hooks/usePlatform.js";

/** 浏览器下载：只确认下载请求已交给浏览器（原 Web 端实现，fixture 内联）。 */
function saveBrowserFile(request) {
  const objectUrl = URL.createObjectURL(
    new Blob([request.data], { type: "application/octet-stream" }),
  );
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = request.suggestedName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  return { success: true, downloadStarted: true, name: request.suggestedName };
}

const params = new URLSearchParams(location.search);
const locale = params.get("locale") || "en-US";
const outcome = params.get("outcome") || "download";
window.exportCalls = { saves: 0, releases: 0 };
const bytes = Uint8Array.from([80, 75, 0, 255, 1, 2, 3]);
const descriptor = {
  archiveId: "fixture",
  suggestedName: "conversation-report.zcodium",
  byteLength: bytes.length,
};
const service = {
  readExportChunk: async (_id, offset) => btoa(String.fromCharCode(...bytes.slice(offset))),
  releaseExport: async () => {
    window.exportCalls.releases++;
  },
};
// Only the native save dialog is substituted; Web uses its actual browser download adapter.
const platform = {
  saveFile: async (request) => {
    window.exportCalls.saves++;
    if (window.exportCalls.saves === 1 && outcome === "cancel")
      return { success: false, canceled: true };
    if (window.exportCalls.saves === 1 && outcome === "failure")
      throw new Error("test save failure");
    if (outcome === "download") return saveBrowserFile(request);
    return { success: true, name: "renamed-by-user.zcodium" };
  },
};
function Fixture() {
  const [title, setTitle] = useState("Offline report");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [closed, setClosed] = useState(false);
  const busy = useRef(false);
  const confirm = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      const saved = await saveConversationExport(service, platform, descriptor);
      if (!saved.canceled && saved.success) setResult(saved);
    } catch {
      setError({ issues: [], issueCount: 1, messageId: "conversationShare.publishFailed" });
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return (
    <main className="mx-auto w-full max-w-3xl p-4 bg-background text-ui-base text-foreground">
      {closed ? (
        <p role="status">Closed</p>
      ) : result ? (
        <ConversationShareSuccessDock
          title={result.name ?? descriptor.suggestedName}
          downloadStarted={result.downloadStarted}
          onDismiss={() => setClosed(true)}
        />
      ) : (
        <ConversationShareConfirmationDock
          selectedCount={2}
          totalCount={3}
          title={title}
          onTitleChange={setTitle}
          pending={pending}
          progressPhase="saving"
          error={error}
          onConfirm={confirm}
          onBack={() => setClosed(true)}
          onCancel={() => setClosed(true)}
        />
      )}
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
