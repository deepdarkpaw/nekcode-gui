import type { IProviderSettingsService, ProviderSettingsView } from "@zcode/services";

export type ProviderSettingsState =
  | { status: "loading" }
  | { status: "ready"; view: ProviderSettingsView }
  | { status: "error"; error: Error };

interface ProviderSettingsSnapshotConnection {
  readonly ready: Promise<void>;
  dispose(): void;
}

export function connectProviderSettingsSnapshot(
  service: IProviderSettingsService,
): ProviderSettingsSnapshotConnection {
  let lastRevision = -1;
  let sawReadyView = false;

  const commit = (view: ProviderSettingsView): void => {
    if (view.revision <= lastRevision) return;
    lastRevision = view.revision;
    sawReadyView = true;
  };

  const read = async (): Promise<void> => {
    try {
      commit(await service.getView());
    } catch (cause) {
      // 已有成功快照时保留 Last Known Good；只有首次失败才交给调用方记录。
      if (sawReadyView) return;
      throw cause instanceof Error ? cause : new Error(String(cause));
    }
  };

  // 先订阅再读取，避免 getView 与 Registry 更新之间丢失事件。
  const subscription = service.onDidChange(commit);

  return {
    ready: read(),
    dispose() {
      subscription.dispose();
    },
  };
}
