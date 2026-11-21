import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";
import type { NekModelsSnapshot } from "./modelsDocument.js";

export type ModelScopeRename =
  | { kind: "provider"; from: string; to: string }
  | { kind: "model"; provider: string; from: string; to: string };

type Providers = NekModelsSnapshot["providers"];

function idsOf(provider: Providers[string] | undefined): Set<string> {
  return new Set(
    Array.isArray(provider?.models)
      ? provider.models.flatMap((model) =>
          isPlainObject(model) && typeof model.id === "string" ? [model.id] : [],
        )
      : [],
  );
}

/** 只识别可确定归属的引用；裸 ID、模糊和跨服务商 glob 继续由 nek 解析。 */
function splitKnownRef(pattern: string, refs: ReadonlySet<string>): [string, string] {
  const key = pattern.toLowerCase();
  if (refs.has(key)) return [key, ""];
  const colon = key.lastIndexOf(":");
  if (colon > key.indexOf("/") && refs.has(key.slice(0, colon))) {
    return [key.slice(0, colon), pattern.slice(colon)];
  }
  return [key, ""];
}

/**
 * 改名/删除模型或服务商时，同步 enabledModels 里可确定归属的引用，避免留下失效模式。
 * 新增模型不会写进范围：GUI 与 CLI 是同一个 nek 的两种用法，CLI 改 models.json 时也不会
 * 自动改 enabledModels，GUI 不另造一份需要同步的列表。
 */
export function modelScopeReferenceEdit(
  before: Providers,
  after: Providers,
  rename?: ModelScopeRename,
) {
  const beforeRefs = new Set<string>();
  const providers = new Map<string, string | null>();
  const refs = new Map<string, string | null>();
  for (const provider of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const previous = idsOf(before[provider]);
    const next = idsOf(after[provider]);
    for (const id of previous) beforeRefs.add(`${provider}/${id}`.toLowerCase());
    if (before[provider] && !after[provider]) {
      providers.set(provider.toLowerCase(), rename?.kind === "provider" ? rename.to : null);
      continue;
    }
    if (rename?.kind === "provider" && provider === rename.to) continue;
    const modelRename = rename?.kind === "model" && rename.provider === provider ? rename : null;
    for (const id of previous) {
      if (!next.has(id)) {
        refs.set(
          `${provider}/${id}`.toLowerCase(),
          modelRename?.from === id ? `${provider}/${modelRename.to}` : null,
        );
      }
    }
  }
  if (!providers.size && !refs.size) return undefined;
  const apply = (patterns: readonly string[]): string[] =>
    patterns.flatMap((original) => {
      const pattern = original.trim();
      const slash = pattern.indexOf("/");
      const provider = slash > 0 ? providers.get(pattern.slice(0, slash).toLowerCase()) : undefined;
      if (provider === null) return [];
      if (provider !== undefined) return [`${provider}${pattern.slice(slash)}`];
      const [ref, suffix] = splitKnownRef(pattern, beforeRefs);
      const replacement = refs.get(ref);
      if (replacement === null) return [];
      return [replacement === undefined ? original : `${replacement}${suffix}`];
    });
  return { apply };
}
