/** Native observation of a directory plus its parent/nearest existing ancestor. */
import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";

export function createDirectoryWatch(
  path: string,
  changed: () => void,
  failed: (error: unknown) => void,
): { refresh(): void; dispose(): void } {
  let watchers: FSWatcher[] = [];
  let disposed = false;
  const close = (): void => {
    for (const watcher of watchers) watcher.close();
    watchers = [];
  };
  const refresh = (): void => {
    if (disposed) return;
    close();
    let ancestor = dirname(path);
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    for (const directory of new Set([ancestor, ...(existsSync(path) ? [path] : [])])) {
      try {
        const watcher = watch(directory, { persistent: false }, () => {
          // A parent event may mean the child's inode was replaced; re-arm before the next edit.
          refresh();
          changed();
        });
        watcher.on("error", failed);
        watchers.push(watcher);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        failed(error);
      }
    }
  };
  refresh();
  return { refresh, dispose: () => { disposed = true; close(); } };
}
