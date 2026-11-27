import { useCallback, useEffect, useState } from "react";
import type { SSHConfigAliasOption } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { getErrorMessage } from "@/lib/errorMessage.js";

/** Shared discovery for the connection chooser, edit form and saved hosts page. */
export function useSshConfigAliases(enabled: boolean) {
  const platform = usePlatform();
  const [aliases, setAliases] = useState<SSHConfigAliasOption[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(enabled);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setError("");
    void platform
      .listSSHConfigAliases()
      .then(
        (result) => {
          if (active) setAliases(result);
        },
        (cause) => {
          if (active) {
            setAliases([]);
            setError(getErrorMessage(cause));
          }
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [enabled, platform, revision]);
  return { aliases, error, loading: enabled && loading, reload };
}
