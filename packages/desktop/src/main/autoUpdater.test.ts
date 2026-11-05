import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  updater: undefined as unknown,
}));

vi.mock("electron", () => ({
  app: { isPackaged: true, getVersion: () => "0.1.2" },
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }],
  },
  Menu: { getApplicationMenu: () => null },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
    on: vi.fn(),
  },
}));
vi.mock("electron-updater", async () => {
  const { CancellationToken } =
    await vi.importActual<typeof import("electron-updater")>("electron-updater");
  return {
    default: {
      get autoUpdater() {
        return mocks.updater;
      },
    },
    CancellationToken,
  };
});
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./manifestUpdateProvider.js", () => ({
  ManifestUpdateProvider: class {},
  getElectronReleasePlatform: () => "win-x64",
}));

let updater: EventEmitter & {
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
};
let api: typeof import("./autoUpdater.js");
let finishDownload: (paths: string[]) => void;
let failDownload: (error: Error) => void;

beforeEach(async () => {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.send.mockClear();
  updater = Object.assign(new EventEmitter(), {
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    downloadUpdate: vi.fn(
      () =>
        new Promise<string[]>((resolve, reject) => {
          finishDownload = resolve;
          failDownload = reject;
        }),
    ),
  });
  mocks.updater = updater;
  api = await import("./autoUpdater.js");
  await api.initAutoUpdater();
  updater.emit("update-available", { version: "0.1.3", releaseNotes: "Fixes" });
  await vi.waitFor(() => expect(api.getAutoUpdaterState().kind).toBe("update-available"));
});

afterEach(async () => {
  finishDownload?.([]);
  await api.initAutoUpdater({ enabled: false });
});

function command(channel: string) {
  return mocks.handlers.get(channel)!();
}

test("U1/U2: accepts download once and broadcasts progress before any network event", () => {
  command(PlatformChannels.DownloadUpdate);
  command(PlatformChannels.DownloadUpdate);
  expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  expect(api.getAutoUpdaterState()).toMatchObject({
    kind: "download-progress",
    version: "0.1.3",
    progress: "0",
  });
  expect(api.getAutoUpdaterState()).not.toHaveProperty("totalBytes");
  expect(mocks.send).toHaveBeenCalledWith(
    PlatformChannels.UpdateStateChanged,
    api.getAutoUpdaterState(),
  );
});

test("U2: preparation can be cancelled and late progress cannot revive it", () => {
  command(PlatformChannels.DownloadUpdate);
  const token = updater.downloadUpdate.mock.calls[0]![0];
  command(PlatformChannels.CancelUpdateDownload);
  expect(token.cancelled).toBe(true);
  updater.emit("download-progress", {
    percent: 25,
    transferred: 25,
    total: 100,
    bytesPerSecond: 10,
  });
  expect(api.getAutoUpdaterState()).toMatchObject({ kind: "update-available", version: "0.1.3" });
});

test("U3: real byte progress replaces preparation and completion stays ready", async () => {
  command(PlatformChannels.DownloadUpdate);
  updater.emit("download-progress", {
    percent: 25,
    transferred: 25,
    total: 100,
    bytesPerSecond: 10,
  });
  expect(api.getAutoUpdaterState()).toMatchObject({
    kind: "download-progress",
    progress: "25",
    transferredBytes: 25,
    totalBytes: 100,
  });
  updater.emit("update-downloaded", { version: "0.1.3" });
  finishDownload([]);
  await Promise.resolve();
  expect(api.getAutoUpdaterState()).toMatchObject({ kind: "update-downloaded", version: "0.1.3" });
});

test("U3: cache completion without progress is not overwritten by preparation", () => {
  updater.downloadUpdate.mockImplementationOnce(() => {
    updater.emit("update-downloaded", { version: "0.1.3" });
    return Promise.resolve([]);
  });
  command(PlatformChannels.DownloadUpdate);
  expect(api.getAutoUpdaterState()).toMatchObject({ kind: "update-downloaded", version: "0.1.3" });
});

test("U3: preparation rejection restores a retryable update", async () => {
  command(PlatformChannels.DownloadUpdate);
  failDownload(new Error("offline"));
  await vi.waitFor(() => expect(api.getAutoUpdaterState().kind).toBe("update-available"));
  command(PlatformChannels.DownloadUpdate);
  expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
  expect(api.getAutoUpdaterState().kind).toBe("download-progress");
});
