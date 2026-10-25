/**
 * 设置中心数据层入口：
 * - `NekSettingsProvider` 注入 `INekConfigApi`（renderer 只通过它读写 nek 配置）与 GUI 侧 host API；
 * - 当前"配置目标"（本机 / 远程连接）放在模块级 store，切换页面时保持；切换目标后各页面按新目标重新加载；
 * - 每个目标只建立一个 `watch` 订阅，经 watch hub 分发给各文档 hook；
 * - `writeVersion`：任意写入成功或外部修改后递增，非文档类查询（可用模型、登录状态等）据此刷新。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { create } from "zustand";
import type {
  INekConfigApi,
  NekConfigTarget,
  NekConfigTargetInfo,
} from "@zcode/shared/nek-protocol";
import type { INekSettingsHostApi } from "./hostApi.js";
import { toNekConfigApiError, wrapNekConfigApi, type NekConfigApiError } from "./nekErrors.js";

export interface NekSettingsApis {
  config: INekConfigApi;
  host: INekSettingsHostApi;
  /** 使用内存模拟实现（后端未接入）：界面显式标注，不静默冒充真实数据。 */
  isMock: boolean;
}

export type NekConfigChange = { file: string; revision: string };
type ChangeListener = (change: NekConfigChange) => void;

export interface NekTargetsState {
  status: "loading" | "ready" | "error";
  list: NekConfigTargetInfo[];
  error?: NekConfigApiError;
}

interface NekSettingsContextValue {
  config: INekConfigApi;
  host: INekSettingsHostApi;
  isMock: boolean;
  projectCwd?: string;
  targets: NekTargetsState;
  target: NekConfigTarget;
  targetKey: string;
  targetInfo: NekConfigTargetInfo | undefined;
  setTarget: (target: NekConfigTarget) => void;
  refreshTargets: () => Promise<void>;
  subscribeChanges: (listener: ChangeListener) => () => void;
  writeVersion: number;
  notifyWrite: () => void;
}

const NekSettingsContext = createContext<NekSettingsContextValue | null>(null);

export const LOCAL_TARGET: NekConfigTarget = { kind: "local" };

export function targetKeyOf(target: NekConfigTarget): string {
  return target.kind === "local" ? "local" : `remote:${target.connectionId}`;
}

export function sameTarget(a: NekConfigTarget, b: NekConfigTarget): boolean {
  return targetKeyOf(a) === targetKeyOf(b);
}

interface TargetSelectionStore {
  target: NekConfigTarget;
  setTarget: (target: NekConfigTarget) => void;
}

/** 当前配置目标：模块级，设置页内切换分区时保持。 */
export const useNekTargetSelection = create<TargetSelectionStore>((set) => ({
  target: LOCAL_TARGET,
  setTarget: (target) => set({ target }),
}));

function useTargetsLoader(config: INekConfigApi) {
  const [targets, setTargets] = useState<NekTargetsState>({ status: "loading", list: [] });
  const refreshTargets = useCallback(async () => {
    try {
      const list = await config.listTargets();
      setTargets({ status: "ready", list });
    } catch (error) {
      setTargets((current) => ({ ...current, status: "error", error: toNekConfigApiError(error) }));
    }
  }, [config]);
  return { targets, refreshTargets };
}

function useWatchHub(config: INekConfigApi, target: NekConfigTarget, connected: boolean) {
  const listenersRef = useRef(new Set<ChangeListener>());
  // target 以 key 为准，避免每次渲染的新对象重复订阅。
  const targetRef = useRef(target);
  targetRef.current = target;
  const targetKey = targetKeyOf(target);
  useEffect(() => {
    if (!connected) {
      return undefined;
    }
    return config.watch(targetRef.current, (change) => {
      for (const listener of listenersRef.current) {
        listener(change);
      }
    });
  }, [config, targetKey, connected]);
  return useCallback((listener: ChangeListener) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);
}

export function NekSettingsProvider({
  apis,
  projectCwd,
  children,
}: {
  apis: NekSettingsApis;
  projectCwd?: string;
  children: ReactNode;
}) {
  const config = useMemo(() => wrapNekConfigApi(apis.config), [apis.config]);
  const { targets, refreshTargets } = useTargetsLoader(config);
  const target = useNekTargetSelection((state) => state.target);
  const setTarget = useNekTargetSelection((state) => state.setTarget);
  const targetKey = targetKeyOf(target);
  const targetInfo = targets.list.find((info) => targetKeyOf(info.target) === targetKey);
  const subscribeChanges = useWatchHub(config, target, targetInfo?.connected === true);
  const [writeVersion, setWriteVersion] = useState(0);
  const notifyWrite = useCallback(() => setWriteVersion((version) => version + 1), []);

  useEffect(() => {
    void refreshTargets();
    return apis.host.onHostsChanged(() => void refreshTargets());
  }, [apis.host, refreshTargets]);

  const value = useMemo<NekSettingsContextValue>(
    () => ({
      config,
      host: apis.host,
      isMock: apis.isMock,
      projectCwd,
      targets,
      target,
      targetKey,
      targetInfo,
      setTarget,
      refreshTargets,
      subscribeChanges,
      writeVersion,
      notifyWrite,
    }),
    [
      config,
      apis.host,
      apis.isMock,
      projectCwd,
      targets,
      target,
      targetKey,
      targetInfo,
      setTarget,
      refreshTargets,
      subscribeChanges,
      writeVersion,
      notifyWrite,
    ],
  );
  return <NekSettingsContext.Provider value={value}>{children}</NekSettingsContext.Provider>;
}

export function useNekSettingsContext(): NekSettingsContextValue {
  const context = useContext(NekSettingsContext);
  if (!context) {
    throw new Error("useNekSettingsContext must be used inside <NekSettingsProvider>");
  }
  return context;
}

/** renderer 读写 nek 配置的唯一入口。 */
export function useNekConfigApi(): INekConfigApi {
  return useNekSettingsContext().config;
}

export function useNekHostApi(): INekSettingsHostApi {
  return useNekSettingsContext().host;
}

/** 当前配置目标与目标列表。 */
export function useNekTarget() {
  const { target, targetKey, targetInfo, targets, setTarget, refreshTargets } =
    useNekSettingsContext();
  return { target, targetKey, targetInfo, targets, setTarget, refreshTargets };
}
