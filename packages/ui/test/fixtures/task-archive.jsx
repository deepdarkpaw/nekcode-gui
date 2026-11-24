import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseNekBuiltinSlashCommand } from "@zcode/shared/nek-protocol";
import { ConfirmDialogHost } from "../../src/ConfirmDialog.js";
import { NewTaskButtonGroup } from "../../src/NewTaskButtonGroup.js";
import { TaskArchiveExportButton } from "../../src/TaskArchiveExportButton.js";
import { useConversationArchiveImport } from "../../src/root/useConversationArchiveImport.js";
import { ConversationImportProvider } from "../../src/hooks/useConversationImport.js";
import { selectBrowserFileData } from "../../src/lib/browserFilePicker.js";
import { ZCodeIntlProvider, useZCodeIntl } from "../../src/i18n/IntlProvider.js";
import { PlatformProvider } from "../../src/hooks/usePlatform.js";
import { ServiceProvider } from "../../src/hooks/useServices.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { TabStoreProvider, useTabStoreApi } from "../../src/store/TabStoreProvider.js";
import {
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
} from "../../src/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "../../src/store/zcodeSessionStore.js";
import { executeBuiltinSlashCommand } from "../../src/v4/builtinSlashActions.js";

const params = new URLSearchParams(location.search);
const locale = params.get("locale") || "en-US";
const outcome = params.get("outcome") || "success";
const remote = params.get("remote") === "1";
const path = "/fixture/workspace";
const remoteSessionId = "attached-ssh";
const identity = "ssh-fixture:/fixture/workspace";
const target = {
  workspacePath: path,
  ...(remote ? { workspaceIdentity: identity, remoteSessionId } : {}),
};
const nativeText =
  '{"type":"session","version":3,"id":"native-fixture"}\n{"type":"message","id":"u1","parentId":null,"message":{"role":"user","content":"归档 fixture"}}\n';
const nativeBytes = new TextEncoder().encode(nativeText);

export function mountTaskArchiveFixture(saveBrowserFile) {
  document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
  document.documentElement.dataset.theme =
    params.get("theme") === "dark" ? "zai-dark" : "zai-light";
  const calls = {
    actions: [],
    nativeText,
    saves: [],
    opened: [],
    pending: [],
    created: 0,
    slash: null,
  };
  window.archiveCalls = calls;
  const count = (action) => calls.actions.filter((entry) => entry.action === action).length;
  const hold = () => new Promise((resolve) => calls.pending.push(resolve));
  function services(host) {
    const transfers = new Map();
    return {
      zcodeAgentService: {
        async nekTaskArchive(request) {
          const {
            action,
            archiveId,
            offset,
            byteLength,
            workspacePath,
            workspaceIdentity,
            sessionId,
          } = request;
          calls.actions.push({
            host,
            action,
            archiveId,
            workspacePath,
            workspaceIdentity,
            byteLength,
            sessionId,
            offset,
          });
          switch (action) {
            case "beginImport": {
              const id = `${host}-${count(action)}`;
              transfers.set(id, new Uint8Array(byteLength));
              return { action, archiveId: id };
            }
            case "appendImport": {
              if (outcome === "upload-switch") await hold();
              if (outcome === "failure" && count(action) === 1)
                throw new Error("fixture upload failed");
              const chunk = Uint8Array.from(atob(request.data), (char) => char.charCodeAt(0));
              transfers.get(archiveId).set(chunk, offset);
              return { action };
            }
            case "import":
              calls.uploaded = new TextDecoder().decode(transfers.get(archiveId));
              if (outcome === "switch") await hold();
              if (outcome === "unknown") throw new Error("fixture reply lost after commit started");
              if (outcome === "corrupt") throw new Error("fault.taskArchive.invalidFile");
              return { action, sessionId: `imported-${host}-${count(action)}` };
            case "export":
              if (outcome === "locked") throw new Error("fault.taskArchive.taskLocked");
              return {
                action,
                archive: {
                  archiveId: `${host}-out-${count(action)}`,
                  byteLength: nativeBytes.length,
                  suggestedName: "task-fixture.jsonl",
                },
              };
            case "readExport":
              if (outcome === "read-switch") await hold();
              if (outcome === "read-failure") throw new Error("SSH connection lost");
              return { action, data: btoa(String.fromCharCode(...nativeBytes.subarray(offset))) };
            case "release":
              transfers.delete(archiveId);
              return { action };
            default:
              throw new Error("Unexpected archive request");
          }
        },
      },
    };
  }
  const local = services("local");
  const replace = (host) =>
    registerRemoteWorkspaceSession({ sessionId: remoteSessionId, services: services(host) });
  if (remote && outcome !== "disconnected") replace("ssh-A");
  window.replaceArchiveHost = () => replace("ssh-B");
  window.disconnectArchiveHost = () => unregisterRemoteWorkspaceSession(remoteSessionId);
  const platform = {
    selectFileData: outcome === "unavailable" ? undefined : selectBrowserFileData,
    async saveFile(request) {
      calls.saves.push({
        name: request.suggestedName,
        text: new TextDecoder().decode(request.data),
        after: calls.actions.at(-1)?.action,
      });
      if (outcome === "cancel" && calls.saves.length === 1)
        return { success: false, canceled: true };
      if (outcome === "save-failure" && calls.saves.length === 1)
        return { success: false, error: "write_failed" };
      if (outcome === "download") return saveBrowserFile(request);
      return { success: true, name: "renamed-by-user.jsonl" };
    },
  };

  function Fixture() {
    const { intl } = useZCodeIntl();
    const archive = useConversationArchiveImport({ platform, intl, isDesktop: true });
    const tabs = useTabStoreApi();
    const [text, setText] = useState("");
    const [notice, setNotice] = useState("");
    const [taskId, setTaskId] = useState(params.get("draft") === "1" ? null : "fixture-task");
    useLayoutEffect(() => {
      tabs.getState().addTab(path);
      if (remote) tabs.getState().addTab(path, { workspaceIdentity: identity, remoteSessionId });
      const store = useZCodeSessionStore;
      store.getState().setActiveTaskId(path, taskId, target.workspaceIdentity);
      window.switchArchiveTask = (id) =>
        store.getState().setActiveTaskId(path, id, target.workspaceIdentity);
      return store.subscribe((state) => {
        // Read the captured workspace bucket, not whatever happens to be active in another tab.
        const id = state.getWorkspaceState(path, target.workspaceIdentity).activeTaskId;
        if (id?.startsWith("imported-") && !calls.opened.includes(id)) calls.opened.push(id);
        setTaskId(id);
      });
      // Fixture bootstrap must run only once, not when the imported task is selected.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tabs]);
    const submit = async (event) => {
      event.preventDefault();
      const command = parseNekBuiltinSlashCommand(text);
      if (!command) throw new Error("Fixture only accepts control commands");
      const reply = await executeBuiltinSlashCommand(
        command,
        false,
        {
          sessionId: taskId,
          openTaskArchive: (mode, current) =>
            mode === "import"
              ? archive.open(target, current)
              : archive.exportTask(target, taskId, current),
        },
        () => true,
      );
      calls.slash = reply;
      setNotice(
        reply.notice ? intl.formatMessage({ id: reply.notice.id }, reply.notice.values) : "",
      );
      if (reply.status === "sent") setText("");
    };
    return (
      <ConversationImportProvider value={archive}>
        <main className="min-h-screen bg-background p-4 text-foreground">
          <div className="flex max-w-80 items-center gap-2 rounded-xl border border-border p-2">
            <NewTaskButtonGroup onCreateTask={() => calls.created++} />
            {taskId ? <TaskArchiveExportButton target={target} taskId={taskId} /> : null}
          </div>
          <form className="mt-8 flex max-w-80 gap-2" onSubmit={submit}>
            <input
              aria-label="Slash command"
              className="min-w-0 rounded-md border border-border px-2 text-ui-base"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <button type="submit" className="text-ui-base">
              Run
            </button>
          </form>
          {notice ? (
            <p role="status" className="mt-2 text-ui-base">
              {notice}
            </p>
          ) : null}
          {taskId?.startsWith("imported-") ? (
            <p data-testid="opened-native-task" className="mt-4 text-ui-base">
              {taskId}
            </p>
          ) : null}
        </main>
        <ConfirmDialogHost />
      </ConversationImportProvider>
    );
  }
  createRoot(document.getElementById("root")).render(
    <PlatformProvider platform={platform}>
      <ServiceProvider services={local}>
        <ZCodeIntlProvider initialLocale={locale}>
          <TooltipProvider>
            <TabStoreProvider>
              <Fixture />
            </TabStoreProvider>
          </TooltipProvider>
        </ZCodeIntlProvider>
      </ServiceProvider>
    </PlatformProvider>,
  );
}
