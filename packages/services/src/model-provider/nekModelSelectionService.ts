/**
 * `IModelSelectionService` 的唯一实现：把 nek 的模型事实投影成 renderer 用的 View。
 *
 * 状态模型刻意只有一个：
 * - 事实不缓存：每次 `getView()` 都读一次（读失败就是失败，交回调用方展示/重试）；
 * - `onDidChange` 只是**失效信号**，不携带快照；所有调用方重新 `getView()`；
 * - `revision` 只随事实内容变化前进，且只有“比已提交读取更新”的那次读取才能提交，
 *   并发/乱序完成不会把旧目录当成当前版本。
 */
import {
  resolveEffectiveModelSelection,
  resolveInitialModelSelection,
  type ModelSelectionView,
  type ModelSelectionViewInput,
} from "@zcode/shared/model-selection-resolution";
import type { IModelSelectionService } from "./modelSelectionService.js";
import type { NekModelFacts, NekModelFactsSource } from "./nekModelFacts.js";
import {
  DEFAULT_MODEL_READ_MS,
  NekModelReadBudget,
  waitForModelRead,
  assertModelRead,
} from "../nek-config-api/index.js";

interface NekModelSelectionServiceOptions {
  readonly facts: NekModelFactsSource;
}

interface NekModelSelectionService extends IModelSelectionService {
  dispose(): void;
}

/** 一次 `getView()` 最多读几次：被更新的读取超车时重读，避免把旧目录当当前事实返回。 */
const MAX_READ_ATTEMPTS = 2;

export function createNekModelSelectionService(
  options: NekModelSelectionServiceOptions,
): NekModelSelectionService {
  const source = options.facts;
  let revision = 0;
  let lastKey: string | null = null;
  /** Settled reads, including failures, fence older results. */
  let settledSequence = 0;
  let startedSequence = 0;
  let disposed = false;
  const flights = new Map<
    string,
    {
      promise: Promise<{ facts: NekModelFacts; revision: number }>;
      budget: NekModelReadBudget;
      waiters: number;
    }
  >();

  /** A temporary scope lease fences this read even when no other caller re-reads. */
  const readFacts = async (
    cwd: string,
    budget: NekModelReadBudget,
  ): Promise<{ facts: NekModelFacts; revision: number }> => {
    const scope = cwd ? { cwd } : undefined;
    let epoch = 0;
    const release = source.onDidChange(() => {
      epoch = 1;
    }, scope);
    try {
      // Initial directory baselines establish observation, not a configuration mutation during this read.
      if (release.ready) await waitForModelRead(release.ready, budget.context);
      for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
        epoch = 0;
        assertModelRead(budget.context);
        const sequence = ++startedSequence;
        let facts: NekModelFacts;
        try {
          facts = await waitForModelRead(
            source.read({ ...scope, ...budget.context }),
            budget.context,
          );
        } catch (error) {
          const superseded = sequence < settledSequence;
          settledSequence = Math.max(settledSequence, sequence);
          if (disposed) throw new Error("ModelSelectionService 已 dispose");
          assertModelRead(budget.context);
          if (epoch || superseded) continue;
          throw error;
        }
        if (disposed) throw new Error("ModelSelectionService 已 dispose");
        const superseded = sequence < settledSequence;
        settledSequence = Math.max(settledSequence, sequence);
        assertModelRead(budget.context);
        const key = catalogKey(facts);
        // An unrelated workspace can finish later without changing the shared catalog. It must
        // not make a stable read retry forever; actual invalidations still fence every result.
        if (epoch || (superseded && key !== lastKey)) continue;
        if (key !== lastKey) {
          lastKey = key;
          revision += 1;
        }
        return { facts, revision };
      }
      throw new Error("Model configuration changed during every read; retry the read");
    } finally {
      release();
    }
  };

  // The service lifetime owns global observation; workspace observation is always leased.
  const unsubscribe = source.onDidChange(() => undefined);

  return {
    async getView(
      input?: ModelSelectionViewInput,
      read?: { readonly elapsedMs: number },
    ): Promise<ModelSelectionView> {
      if (disposed) throw new Error("ModelSelectionService 已 dispose");
      const cwd = input?.workspacePath?.trim() ?? "";
      const elapsed = read?.elapsedMs ?? 0;
      if (!Number.isFinite(elapsed) || elapsed < 0)
        throw new Error("Invalid model read elapsed budget");
      const remaining = (source.modelReadMs ?? DEFAULT_MODEL_READ_MS) - elapsed;
      let flight = flights.get(cwd);
      if (!flight) {
        if (flights.size >= 128) throw new Error("Model read scope capacity exceeded; retry");
        const budget = new NekModelReadBudget(remaining);
        const promise = readFacts(cwd, budget).finally(() => {
          const timings = budget.finish();
          budget.abort();
          source.reportReadTiming?.(timings);
          if (flights.get(cwd)?.budget === budget) flights.delete(cwd);
        });
        flight = { promise, budget, waiters: 0 };
        flights.set(cwd, flight);
      }
      if (flight.waiters >= 1024) throw new Error("Model read waiter capacity exceeded; retry");
      const waiter = new NekModelReadBudget(remaining);
      waiter.context.stage?.("shared-read");
      flight.waiters += 1;
      try {
        const result = await waitForModelRead(flight.promise, waiter.context);
        return project(result.facts, result.revision, input);
      } finally {
        waiter.finish();
        flight.waiters -= 1;
        if (flight.waiters === 0) {
          flight.budget.abort();
          if (flights.get(cwd) === flight) flights.delete(cwd);
        }
      }
    },
    onDynamicDidChange: (scope) => (listener) => {
      if (disposed) throw new Error("ModelSelectionService 已 dispose");
      const release = source.onDidChange(listener, { cwd: scope.workspacePath });
      return { dispose: release };
    },
    onDidChange: (listener) => {
      if (disposed) return { dispose: () => undefined };
      return { dispose: source.onDidChange(listener) };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const flight of flights.values())
        flight.budget.abort(new Error("ModelSelectionService 已 dispose"));
      flights.clear();
      unsubscribe();
      source.dispose();
    },
  };
}

/**
 * `revision` 只跟“有哪些可用模型、各自支持什么”这一事实走。
 *
 * 按 workspace 变化的默认档位（`defaultReasoningLevel`）与默认模型不进版本：不同 workspace
 * 交替读取不能让版本号来回跳，也不能因此重建草稿运行时。
 */
function catalogKey(facts: NekModelFacts): string {
  return JSON.stringify([
    facts.providers,
    facts.models.map((model) => [
      model.providerId,
      model.modelId,
      model.displayName,
      model.reasoningLevels,
      model.supportsImage,
    ]),
  ]);
}

/** 纯投影：nek 事实 → Selection View（含首选选择与当前选择的解析）。 */
function project(
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
        ...(model.defaultReasoningLevel
          ? { defaultReasoningLevel: model.defaultReasoningLevel }
          : {}),
        supportsImage: model.supportsImage,
      })),
  }));
  const catalog = { providers };
  const initial = resolveInitialModelSelection({
    catalog,
    ...(facts.defaults.providerId !== undefined || facts.defaults.modelId !== undefined
      ? {
          configuredDefault: {
            providerId: facts.defaults.providerId ?? "",
            modelId: facts.defaults.modelId ?? "",
          },
        }
      : {}),
  });
  return Object.freeze({
    revision,
    providers: Object.freeze(
      providers.map((provider) =>
        Object.freeze({ ...provider, models: Object.freeze(provider.models) }),
      ),
    ),
    ...(initial.selection ? { preferredSelection: initial.selection } : {}),
    ...(initial.issue ? { preferredSelectionIssue: initial.issue } : {}),
    ...(input ? resolveEffectiveModelSelection({ selection: input.selection, catalog }) : {}),
  });
}
