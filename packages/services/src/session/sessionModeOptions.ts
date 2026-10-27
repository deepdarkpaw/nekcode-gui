import { normalizeZCodeTaskMode } from "@zcode/shared";
import type { ZCodeConfigOption, ZCodeProvider, ZCodeTaskMode } from "@zcode/shared";

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function getModeConfigOption(options: readonly ZCodeConfigOption[]): ZCodeConfigOption | undefined {
  return options.find((option) => option.category === "mode" && option.type === "select");
}

function normalizePersistedSessionMode(
  modeId: string | null | undefined,
  _provider?: ZCodeProvider,
): ZCodeTaskMode | undefined {
  const trimmedModeId = readTrimmedString(modeId);
  if (!trimmedModeId) {
    return undefined;
  }

  // provider 原生 modeId 与本地持久化值都可能是旧枚举；统一按 agent / plan 归一。
  return normalizeZCodeTaskMode(trimmedModeId);
}

export function resolveProviderModeIdFromConfigOptions(params: {
  configOptions: readonly ZCodeConfigOption[];
  modeId: string | null | undefined;
  provider?: ZCodeProvider;
}): string | undefined {
  const requestedMode = readTrimmedString(params.modeId);
  if (!requestedMode) {
    return undefined;
  }

  const modeOption = getModeConfigOption(params.configOptions);
  const candidates = modeOption?.options ?? [];
  const exactMatch = candidates.find((candidate) => candidate.value === requestedMode);
  if (exactMatch) {
    return exactMatch.value;
  }

  const requestedPersistedMode = normalizePersistedSessionMode(
    requestedMode,
    params.provider,
  );
  if (!requestedPersistedMode) {
    return undefined;
  }

  const semanticMatch = candidates.find(
    (candidate) =>
      normalizePersistedSessionMode(candidate.value, params.provider) ===
      requestedPersistedMode,
  );

  return semanticMatch?.value;
}
