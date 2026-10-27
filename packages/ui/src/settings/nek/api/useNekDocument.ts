/**
 * 带 revision 的配置文档 hook（settings.json / models.json / mcp.json / nek.yaml ……）：
 *
 * - 读取：目标或参数变化时重新加载；目标未连接时不加载（status = "disconnected"）；
 * - 写入：串行队列，每次用最新 revision；乐观更新，失败回滚并抛出本地化错误（字段原位显示原因）；
 *   成功后静默重新读取一次，与磁盘对齐；
 * - 冲突（`code: "conflict"`）：保留这次写入，显示横幅"配置已在外部修改 [重新载入] [保留我的修改]"；
 *   重新载入 = 丢弃这次写入并重置表单草稿；保留我的修改 = 读取最新 revision 后重放这次写入；
 * - 外部修改（watch）：没有未保存改动时静默刷新；有未保存改动（表单草稿登记为 dirty）时显示横幅。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { INekConfigApi, NekConfigRevision, NekConfigTarget } from "@zcode/shared/nek-protocol";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useNekSettingsContext } from "./NekSettingsContext.js";
import { NekConfigApiError, localizeNekError, toNekConfigApiError } from "./nekErrors.js";

export type NekDocumentStatus = "disconnected" | "loading" | "ready" | "error";
export type NekDocumentBanner = { kind: "external" } | { kind: "conflict" };

export interface NekMutation<T> {
  /** 乐观更新：立即作用于界面。 */
  optimistic?: (data: T) => T;
  /**
   * 用当前数据（含 revision）写入；返回新 revision。
   * 多文件文档（子代理预设）返回 `{ fileRevision }`：只用于识别自己写入引起的 watch 事件，随后重新读取。
   */
  write: (data: T) => Promise<NekConfigRevision | { fileRevision: string } | void>;
}

export interface NekDocumentOptions<T extends NekConfigRevision> {
  /** 读取函数；参数变化请放进 deps。 */
  load: (api: INekConfigApi, target: NekConfigTarget) => Promise<T>;
  deps?: readonly unknown[];
  /** watch 事件里的文件是否属于本文档；默认比较 `data.path`。 */
  matchesFile?: (file: string, data: T) => boolean;
  enabled?: boolean;
}

export interface NekDocument<T extends NekConfigRevision> {
  status: NekDocumentStatus;
  data: T | undefined;
  error: NekConfigApiError | undefined;
  banner: NekDocumentBanner | null;
  /** "重新载入"后递增：表单据此丢弃草稿。 */
  resetToken: number;
  reload: () => Promise<void>;
  mutate: (mutation: NekMutation<T>) => Promise<void>;
  resolveBanner: (choice: "reload" | "keep") => Promise<void>;
  setDirty: (id: string, dirty: boolean) => void;
}

interface DocState<T> {
  status: NekDocumentStatus;
  data: T | undefined;
  error: NekConfigApiError | undefined;
}

const OWN_REVISION_LIMIT = 32;

export function normalizeConfigPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function defaultMatchesFile(file: string, data: NekConfigRevision): boolean {
  const path = (data as { path?: unknown }).path;
  return typeof path === "string" && normalizeConfigPath(path) === normalizeConfigPath(file);
}

function rememberRevision(set: Set<string>, revision: string): void {
  set.add(revision);
  if (set.size > OWN_REVISION_LIMIT) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) {
      set.delete(oldest);
    }
  }
}

export function useNekDocument<T extends NekConfigRevision>(
  options: NekDocumentOptions<T>,
): NekDocument<T> {
  const { intl } = useZCodeIntl();
  const { config, target, targetKey, targetInfo, subscribeChanges, notifyWrite } =
    useNekSettingsContext();
  const enabled = (options.enabled ?? true) && targetInfo?.connected === true;
  const [state, setState] = useState<DocState<T>>({
    status: enabled ? "loading" : "disconnected",
    data: undefined,
    error: undefined,
  });
  const [banner, setBanner] = useState<NekDocumentBanner | null>(null);
  const [resetToken, setResetToken] = useState(0);

  const latestRef = useRef({ options, config, target, intl });
  latestRef.current = { options, config, target, intl };
  const dataRef = useRef<T | undefined>(undefined);
  const generationRef = useRef(0);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const inFlightRef = useRef(0);
  const ownRevisionsRef = useRef(new Set<string>());
  const dirtyRef = useRef(new Set<string>());
  const pendingRef = useRef<NekMutation<T> | null>(null);

  const setData = useCallback((data: T | undefined) => {
    dataRef.current = data;
    setState({ status: "ready", data, error: undefined });
  }, []);

  const load = useCallback(
    async (silent: boolean) => {
      const generation = generationRef.current;
      const { options: current, config: api, target: currentTarget } = latestRef.current;
      try {
        const data = await current.load(api, currentTarget);
        // 静默刷新期间又开始了新的写入：以写入链为准，避免旧数据覆盖乐观状态。
        const superseded = silent && inFlightRef.current > 0;
        if (generation === generationRef.current && !superseded) {
          setData(data);
        }
      } catch (error) {
        if (generation !== generationRef.current) {
          return;
        }
        const normalized = toNekConfigApiError(error);
        if (silent && dataRef.current) {
          toast(normalized.message, { variant: "warning" });
          return;
        }
        setState({ status: "error", data: undefined, error: normalized });
      }
    },
    [setData],
  );

  const depsKey = JSON.stringify(options.deps ?? []);
  useEffect(() => {
    generationRef.current += 1;
    dataRef.current = undefined;
    pendingRef.current = null;
    setBanner(null);
    if (!enabled) {
      setState({ status: "disconnected", data: undefined, error: undefined });
      return;
    }
    setState({ status: "loading", data: undefined, error: undefined });
    void load(false);
  }, [enabled, targetKey, depsKey, load]);

  const reconcile = useCallback(async () => {
    if (inFlightRef.current === 0) {
      await load(true);
    }
  }, [load]);

  const runMutation = useCallback(
    async (mutation: NekMutation<T>) => {
      const base = dataRef.current;
      if (!base) {
        throw new NekConfigApiError(
          "io",
          latestRef.current.intl.formatMessage({ id: "settings.nek.error.notLoaded" }),
        );
      }
      inFlightRef.current += 1;
      if (mutation.optimistic) {
        setData(mutation.optimistic(base));
      }
      try {
        const result = await mutation.write(base);
        if (result && "fileRevision" in result) {
          rememberRevision(ownRevisionsRef.current, result.fileRevision);
        } else if (result) {
          rememberRevision(ownRevisionsRef.current, result.revision);
          const current = dataRef.current ?? base;
          setData({ ...current, revision: result.revision });
        }
      } catch (error) {
        setData(base);
        const t = (id: string, values?: Record<string, string | number>) =>
          latestRef.current.intl.formatMessage({ id }, values);
        const localized = localizeNekError(error, t);
        if (localized.code === "conflict") {
          pendingRef.current = mutation;
          setBanner({ kind: "conflict" });
        }
        throw localized;
      } finally {
        inFlightRef.current -= 1;
      }
      notifyWrite();
      void reconcile();
    },
    [notifyWrite, reconcile, setData],
  );

  const mutate = useCallback(
    (mutation: NekMutation<T>) => {
      const run = queueRef.current.then(() => runMutation(mutation));
      queueRef.current = run.catch(() => undefined);
      return run;
    },
    [runMutation],
  );

  useEffect(
    () =>
      subscribeChanges((change) => {
        const data = dataRef.current;
        const matches = latestRef.current.options.matchesFile ?? defaultMatchesFile;
        if (!data || !matches(change.file, data)) {
          return;
        }
        if (ownRevisionsRef.current.has(change.revision) || change.revision === data.revision) {
          return;
        }
        if (inFlightRef.current > 0) {
          return;
        }
        if (dirtyRef.current.size > 0 || pendingRef.current) {
          setBanner({ kind: "external" });
          return;
        }
        void load(true).then(notifyWrite);
      }),
    [subscribeChanges, load, notifyWrite],
  );

  const resolveBanner = useCallback(
    async (choice: "reload" | "keep") => {
      setBanner(null);
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (choice === "reload") {
        setResetToken((token) => token + 1);
        await load(true);
        notifyWrite();
        return;
      }
      await load(true);
      if (!pending) {
        return;
      }
      try {
        await mutate(pending);
      } catch (error) {
        if (!(error instanceof NekConfigApiError && error.code === "conflict")) {
          toast(toNekConfigApiError(error).message, { variant: "warning" });
        }
      }
    },
    [load, mutate, notifyWrite],
  );

  const setDirty = useCallback((id: string, dirty: boolean) => {
    if (dirty) {
      dirtyRef.current.add(id);
    } else {
      dirtyRef.current.delete(id);
    }
  }, []);

  const reload = useCallback(() => load(dataRef.current !== undefined), [load]);

  return useMemo(
    () => ({ ...state, banner, resetToken, reload, mutate, resolveBanner, setDirty }),
    [state, banner, resetToken, reload, mutate, resolveBanner, setDirty],
  );
}

/** 表单草稿登记为"未保存改动"：外部修改时改为显示横幅，而不是静默覆盖。 */
export function useNekDirtyRegistration(
  documents: ReadonlyArray<Pick<NekDocument<NekConfigRevision>, "setDirty"> | undefined>,
  dirty: boolean,
): void {
  const id = useId();
  useEffect(() => {
    for (const document of documents) {
      document?.setDirty(id, dirty);
    }
    return () => {
      for (const document of documents) {
        document?.setDirty(id, false);
      }
    };
  }, [documents, id, dirty]);
}

/** 文档"重新载入"时调用 reset（跳过首次）。 */
export function useOnDocumentReset(resetToken: number, reset: () => void): void {
  const firstRef = useRef(true);
  const resetRef = useRef(reset);
  resetRef.current = reset;
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    resetRef.current();
  }, [resetToken]);
}
