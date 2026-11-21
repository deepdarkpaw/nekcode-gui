import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export type {
  ModelSelectionView,
  ModelSelectionViewInput,
} from "@zcode/shared/model-selection-resolution";
import type {
  ModelSelectionView,
  ModelSelectionViewInput,
} from "@zcode/shared/model-selection-resolution";

export interface IModelSelectionService {
  /** 模型事实的失效信号；收到后调用方重新 `getView()`。 */
  readonly onDidChange: Event<void>;
  /** Global + this workspace's invalidations. */
  onDynamicDidChange(scope: { readonly workspacePath?: string }): Event<void>;
  /**
   * Temporary workspace read lease only; no settled facts/cache is retained.
   * `elapsedMs` carries renderer dirty-follow-up time across RPC without comparing remote clocks.
   * Each caller keeps its remaining budget even when joining another caller's shared work.
   * The view carries both the full validation catalog and the target nek's ordered CLI scope.
   */
  getView(
    input?: ModelSelectionViewInput,
    read?: { readonly elapsedMs: number },
  ): Promise<ModelSelectionView>;
}

export const IModelSelectionService = createServiceDescriptor<IModelSelectionService>(
  ServiceChannels.ModelSelection,
);
