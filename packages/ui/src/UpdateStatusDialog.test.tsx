// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { IntlInstance } from "./i18n/IntlProvider.js";
import { UpdateStatusDialog } from "./UpdateStatusDialog.js";
import { deriveUpdateStatusViewModel } from "./updateStatusModel.js";

const messages: Record<string, string> = {
  "updateDialog.downloadingTitle": "Downloading v{version}",
  "updateDialog.downloadProgress": "Download progress",
  "updateDialog.cancelDownload": "Cancel download",
};
const intl: IntlInstance = {
  formatMessage: ({ id }, values) =>
    (messages[id] ?? id).replaceAll("{version}", String(values?.version ?? "")),
};

afterEach(cleanup);

test("U1: initial download state displays the progress area and cancellation without byte events", () => {
  const model = deriveUpdateStatusViewModel({
    legacyReadyVersion: null,
    updateState: {
      kind: "download-progress",
      enabled: false,
      version: "0.1.3",
      progress: "0",
    },
  });
  const action = vi.fn().mockResolvedValue(undefined);
  render(
    <UpdateStatusDialog
      displayVersion={model.displayVersion!}
      edgeToEdge
      intl={intl}
      isUpdateActionPending={false}
      autoDownloadAndInstallUpdates={false}
      localizedUpdateReleaseNotes={null}
      onAutoDownloadAndInstallUpdatesChange={action}
      onCancelDownload={action}
      onDownloadUpdate={action}
      onOpenChange={vi.fn()}
      onOpenReleaseNotesExternalUrl={vi.fn()}
      onRestartUpdate={action}
      onSkipUpdate={action}
      open
      phase={model.dialogPhase}
      progressLabel={model.progressLabel}
      progressValue={model.progressValue}
      releaseDateLabel={null}
      skippableVersion={model.skippableVersion}
    />,
  );
  expect(screen.getByRole("progressbar")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel download" }).hasAttribute("disabled")).toBe(
    false,
  );
  expect(screen.getByText("Download progress")).toBeTruthy();
  expect(model.progressLabel).toBeNull();
});
