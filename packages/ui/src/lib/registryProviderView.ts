import type { ModelSelectionView } from "@zcode/services";

export function resolveProviderLabel(
  providerId: string | undefined,
  selectionView: ModelSelectionView | null,
): string {
  const normalizedId = providerId?.trim() ?? "";
  if (!normalizedId) return "";
  const provider = selectionView?.providers.find(
    (candidate) => candidate.providerId === normalizedId,
  );
  return provider ? provider.displayName?.trim() || normalizedId : normalizedId;
}
