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
  /** Temporary read lease only; no historical workspace watch/cache is retained. */
  getView(input?: ModelSelectionViewInput): Promise<ModelSelectionView>;
}

export const IModelSelectionService = createServiceDescriptor<IModelSelectionService>(
  ServiceChannels.ModelSelection,
);
