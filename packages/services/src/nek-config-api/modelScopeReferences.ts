import type { NekModelScopeEntry } from "@zcode/shared/nek-protocol";
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

export function modelScopeReferenceEdit(
  before: Providers,
  after: Providers,
  rename?: ModelScopeRename,
) {
  const beforeRefs = new Set<string>();
  const afterRefs = new Set<string>();
  const providers = new Map<string, string | null>();
  const refs = new Map<string, string | null>();
  const added: string[] = [];
  for (const provider of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const previous = idsOf(before[provider]);
    const next = idsOf(after[provider]);
    for (const id of previous) beforeRefs.add(`${provider}/${id}`.toLowerCase());
    for (const id of next) afterRefs.add(`${provider}/${id}`.toLowerCase());
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
    for (const id of next) {
      if (!previous.has(id) && modelRename?.to !== id) added.push(`${provider}/${id}`);
    }
  }
  if (!providers.size && !refs.size && !added.length) return undefined;
  const apply = (patterns: readonly string[], scoped: readonly NekModelScopeEntry[]): string[] => {
    const next = patterns.flatMap((original) => {
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
    if (!scoped.length || !patterns.length || !added.length) return next;
    const present = new Set(next.map((pattern) => splitKnownRef(pattern.trim(), afterRefs)[0]));
    const alreadyScoped = new Set(scoped.map(({ provider, id }) => `${provider}/${id}`));
    return [
      ...next,
      ...added.filter((ref) => !present.has(ref.toLowerCase()) && !alreadyScoped.has(ref)),
    ];
  };
  return { hasAdditions: added.length > 0, apply };
}
