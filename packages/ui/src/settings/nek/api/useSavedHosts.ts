import { useCallback, useEffect, useState } from "react";
import type { INekSettingsHostApi, NekRemoteHost } from "./hostApi.js";
import { toNekConfigApiError } from "./nekErrors.js";

/** Keep IPC reads serialized: rapid connection events only require the latest snapshot. */
export function useSavedHosts(api: INekSettingsHostApi, enabled = true, watchWorkspaces = false) {
  const [hosts, setHosts] = useState<NekRemoteHost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let busy = false;
    let dirty = false;
    async function read() {
      if (busy) {
        dirty = true;
        return;
      }
      busy = true;
      do {
        dirty = false;
        try {
          const current = await api.listHosts();
          if (active) {
            setHosts(current);
            setError(null);
          }
        } catch (cause) {
          if (active) setError(toNekConfigApiError(cause).message);
        }
      } while (active && dirty);
      busy = false;
    }
    void read();
    const unsubscribe = api.onHostsChanged(read);
    // Host events cover the settings SSH tunnel; desktop workspace routes have their own lifecycle.
    const timer = watchWorkspaces ? setInterval(read, 5_000) : undefined;
    return () => {
      active = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, [api, enabled, watchWorkspaces, revision]);
  return { hosts, error, reload };
}
