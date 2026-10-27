import { getTasksIndexDatabasePath, markTasksStoragePrepared } from "@zcode/services/storage-startup";
import type { DatabaseStartupState } from "@zcode/shared";
import { DatabaseStartupCoordinator } from "./databaseStartupCoordinator.js";
import { StartupDiskSampler } from "./startupDiskSampler.js";
import { prepareHostStorage } from "./storagePreparationProcesses.js";

const BASELINE_BUDGET_MS = 250;
export function createHostDatabaseStartup(options: {
  startupId?: string;
  publish: (state: DatabaseStartupState) => void;
  initializeServices: () => Promise<void>;
  onFailure: (error: unknown) => void;
}) {
  const abort = new AbortController();
  let sampler: StartupDiskSampler | undefined;
  const coordinator = new DatabaseStartupCoordinator({
    startupId: options.startupId,
    publish: options.publish,
    prepare: async (report) => {
      sampler = new StartupDiskSampler({ onSample: (disk) => coordinator.updateDisk(disk) });
      const currentSampler = sampler;
      const observePath = async (path: string) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            currentSampler.addPath(path),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, BASELINE_BUDGET_MS);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        currentSampler.sealBaseline(path);
        coordinator.updateDisk(currentSampler.snapshot());
      };
      try {
        report("preparing_host_storage", "checking");
        const tasksPath = getTasksIndexDatabasePath();
        await observePath(tasksPath);
        currentSampler.start();
        await prepareHostStorage(
          tasksPath,
          (phase, migration) =>
            report("preparing_host_storage", phase, {
              databaseId: "tasks-index",
              migration,
              finalDatabase: true,
            }),
          abort.signal,
        );
        markTasksStoragePrepared(tasksPath);
        report("starting_services");
        await options.initializeServices();
      } catch (error) {
        try {
          options.onFailure(error);
        } catch {
          /* 诊断失败不覆盖原始错误。 */
        }
        throw error;
      } finally {
        currentSampler.stop();
        coordinator.updateDisk(currentSampler.snapshot());
      }
    },
  });
  return {
    coordinator,
    dispose: () => {
      abort.abort();
      sampler?.stop();
    },
  };
}
