/**
 * `IModelSelectionService` 的唯一实现：把 nek 的模型事实投影成 renderer 用的 View。
 *
 * 这个服务是模型选择事实的 owner：候选、默认偏好、`revision` 与变更通知都只从这里出，
 * 门禁、菜单与 Submission 读同一份结果。没有第二份“GUI registry”或持久化镜像。
 */
import {
  resolveEffectiveModelSelection,
  resolveInitialModelSelection,
  type ModelSelectionView,
  type ModelSelectionViewInput,
} from "@zcode/provider";
import type { IModelSelectionService } from "./providerFacadeServices.js";
import type { NekModelFacts, NekModelFactsSource } from "./nekModelFacts.js";

interface NekModelSelectionServiceOptions {
  readonly facts: NekModelFactsSource;
  readonly log?: { warn: (traceId: undefined, ...args: unknown[]) => void };
}

export interface NekModelSelectionService extends IModelSelectionService {
  dispose(): void;
}

export function createNekModelSelectionService(
  options: NekModelSelectionServiceOptions,
): NekModelSelectionService {
  const { facts: source, log } = options;
  const listeners = new Set<(view: ModelSelectionView) => void>();
  let revision = 0;
  let lastKey: string | null = null;
  let disposed = false;
  let inflight: Promise<NekModelFacts> | null = null;

  const readFacts = (): Promise<NekModelFacts> => {
    // 单飞：同一时刻只允许一次事实读取，避免并发读取把 revision 推乱。
    inflight ??= source.read().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const commit = (facts: NekModelFacts): number => {
    const key = factsKey(facts);
    if (key !== lastKey) {
      lastKey = key;
      revision += 1;
    }
    return revision;
  };

  const unsubscribe = source.onDidChange(() => {
    void (async () => {
      try {
        const facts = await readFacts();
        if (disposed) return;
        const before = lastKey;
        const current = commit(facts);
        // 内容没变（例如只改了无关配置）不产生伪变更：草稿运行时不因此重建。
        if (lastKey === before) return;
        const view = projectModelSelectionView(facts, current);
        for (const listener of listeners) listener(view);
      } catch (error) {
        // 读取失败不改写已有 View：下一次 getView 会把 nek 的结构化错误交给调用方展示。
        if (!disposed) log?.warn(undefined, "[model-selection] nek 模型事实刷新失败", { error });
      }
    })();
  });

  return {
    async getView(input?: ModelSelectionViewInput): Promise<ModelSelectionView> {
      if (disposed) throw new Error("ModelSelectionService 已 dispose");
      const facts = await readFacts();
      if (disposed) throw new Error("ModelSelectionService 已 dispose");
      return projectModelSelectionView(facts, commit(facts), input);
    },
    onDidChange: (listener) => {
      if (disposed) return { dispose: () => undefined };
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      listeners.clear();
      source.dispose();
    },
  };
}

/** `revision` 只随事实内容前进；读取失败或内容未变时不产生伪变更。 */
function factsKey(facts: NekModelFacts): string {
  return JSON.stringify([facts.providers, facts.models, facts.defaults]);
}

/** 纯投影：nek 事实 → Selection View（含默认偏好与当前选择的解析）。 */
function projectModelSelectionView(
  facts: NekModelFacts,
  revision: number,
  input?: ModelSelectionViewInput,
): ModelSelectionView {
  const providers = facts.providers.map((provider) => ({
    providerId: provider.providerId,
    displayName: provider.displayName,
    models: facts.models
      .filter((model) => model.providerId === provider.providerId)
      .map((model) => ({
        modelId: model.modelId,
        displayName: model.displayName,
        reasoningLevels: model.reasoningLevels,
        supportsImage: model.supportsImage,
      })),
  }));
  const catalog = { providers };
  const preferredSelection = resolveInitialModelSelection({
    catalog,
    preferences: {
      ...(facts.defaults.providerId ? { providerId: facts.defaults.providerId } : {}),
      ...(facts.defaults.modelId ? { modelId: facts.defaults.modelId } : {}),
      ...(facts.defaults.reasoningLevel ? { reasoningLevel: facts.defaults.reasoningLevel } : {}),
      reasoningLevelFor: (providerId: string, modelId: string) =>
        facts.defaults.modelReasoningLevels[`${providerId}/${modelId}`],
    },
  });
  return Object.freeze({
    revision,
    providers: Object.freeze(providers.map((provider) => Object.freeze(provider))),
    ...(preferredSelection ? { preferredSelection } : {}),
    ...(input ? resolveEffectiveModelSelection({ selection: input.selection, catalog }) : {}),
  });
}
