import type { NekMentionTargetInfo } from "@zcode/shared/nek-protocol";
import {
  findAllMentions,
  matchMentionTargets,
  mentionQuery,
  nekFuzzyFilter,
  type MentionKind,
} from "@zcode/shared/nek-protocol";

/** MN-3 caps keep completion sorting and cached target projections bounded. */
export const NEK_AGENT_MENTION_LIMIT = 8;
export const NEK_SKILL_MENTION_LIMIT = 8;
export const NEK_FILE_MENTION_LIMIT = 30;
export const NEK_MENTION_TARGET_CACHE_TTL_MS = 30_000;
export const NEK_MENTION_TARGET_CACHE_LIMIT = 32;

export interface NekMentionFile {
  path: string;
  kind?: "file" | "directory";
}

export type NekMentionCandidate =
  | {
      kind: "agent" | "skill";
      name: string;
      label: string;
      description?: string;
      location?: string;
      insertText: string;
    }
  | {
      kind: "file";
      name: string;
      label: string;
      path: string;
      insertText: string;
    };

export interface NekMentionHighlight {
  kind: MentionKind;
  name: string;
  start: number;
  end: number;
  resolved: boolean;
}

function scoreName(name: string, query: string): number | null {
  const normalizedName = name.toLocaleLowerCase();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return 0;
  if (normalizedName.startsWith(normalizedQuery)) return 0;
  if (normalizedName.includes(normalizedQuery)) return 1;
  return null;
}

function sortNames<T extends { name: string }>(items: readonly T[], query: string): T[] {
  return items
    .map((item, index) => ({ item, index, score: scoreName(item.name, query) }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.item.name.localeCompare(right.item.name, undefined, { sensitivity: "base" }) ||
        left.index - right.index,
    )
    .map((entry) => entry.item);
}

function prefixFilter(query: string): { kind?: MentionKind; term: string } {
  if (query.toLocaleLowerCase().startsWith("agent:"))
    return { kind: "agent", term: query.slice(6) };
  if (query.toLocaleLowerCase().startsWith("skill:"))
    return { kind: "skill", term: query.slice(6) };
  return { term: query };
}

function targetCandidate(target: NekMentionTargetInfo): NekMentionCandidate {
  return {
    kind: target.kind,
    name: target.name,
    label: `${target.kind}:${target.name}`,
    ...(target.description ? { description: target.description } : {}),
    ...(target.location ? { location: target.location } : {}),
    insertText: `@${target.kind}:${target.name} `,
  };
}

function fileInsertText(path: string): string {
  // nek's file autocomplete quotes paths containing separators such as spaces.
  return /[\s，．：；！？（）［］｛｝“”‘’…—]/u.test(path) ? `@"${path}" ` : `@${path} `;
}

function fileCandidate(file: NekMentionFile): NekMentionCandidate {
  const path = file.path.trim();
  return {
    kind: "file",
    name: path.split(/[\\/]/u).at(-1) ?? path,
    label: path,
    path,
    insertText: fileInsertText(path),
  };
}

function dedupeTargets(targets: readonly NekMentionTargetInfo[]): NekMentionTargetInfo[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.kind}:${target.name.toLocaleLowerCase()}`;
    if (!target.name.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Build the ordered agent → skill → file candidate list for one mention query. */
export function buildNekMentionCandidates(
  query: string,
  targets: readonly NekMentionTargetInfo[],
  files: readonly NekMentionFile[],
): NekMentionCandidate[] {
  const filter = prefixFilter(query);
  const uniqueTargets = dedupeTargets(targets);
  // Keep the shared matcher as the semantic baseline for kind:name queries; the visible ordering then follows MN-2.
  const matchedTargets = query.includes(":")
    ? matchMentionTargets(uniqueTargets, query)
    : sortNames(uniqueTargets, filter.term);
  const targetOrder = matchedTargets.filter(
    (target) => !filter.kind || target.kind === filter.kind,
  );
  const agents = targetOrder
    .filter((target) => target.kind === "agent")
    .slice(0, NEK_AGENT_MENTION_LIMIT);
  const skills = targetOrder
    .filter((target) => target.kind === "skill")
    .slice(0, NEK_SKILL_MENTION_LIMIT);
  if (filter.kind) return [...(filter.kind === "agent" ? agents : skills)].map(targetCandidate);

  const normalizedQuery = filter.term.toLocaleLowerCase();
  const matchedFiles = normalizedQuery
    ? nekFuzzyFilter(
        files.filter((file) => file.path.toLocaleLowerCase().includes(normalizedQuery)),
        filter.term,
        (file) => file.path,
      )
    : [...files].sort((left, right) =>
        left.path.localeCompare(right.path, undefined, { sensitivity: "base" }),
      );
  return [
    ...agents.map(targetCandidate),
    ...skills.map(targetCandidate),
    ...matchedFiles.slice(0, NEK_FILE_MENTION_LIMIT).map(fileCandidate),
  ];
}

export interface MentionReplacement {
  start: number;
  end: number;
  text: string;
  caretOffset: number;
}

/** Return the plain-text replacement range for a selected candidate. */
export function buildNekMentionReplacement(
  textBeforeCaret: string,
  candidate: NekMentionCandidate,
): MentionReplacement | undefined {
  const query = mentionQuery(textBeforeCaret);
  if (query === undefined) return undefined;
  const start = textBeforeCaret.length - query.length - 1;
  return {
    start,
    end: textBeforeCaret.length,
    text: candidate.insertText,
    caretOffset: start + candidate.insertText.length,
  };
}

/** Serialization deliberately does not add file content or Markdown links. */
export function serializeNekMentionCandidate(candidate: NekMentionCandidate): string {
  return candidate.kind === "file"
    ? candidate.insertText.trimEnd()
    : `@${candidate.kind}:${candidate.name}`;
}

export function serializeNekMentionText(text: string): string {
  return text;
}

export function getNekMentionHighlights(
  text: string,
  targets: readonly NekMentionTargetInfo[],
): NekMentionHighlight[] {
  const resolved = new Set(
    targets.map((target) => `${target.kind}:${target.name.toLocaleLowerCase()}`),
  );
  return findAllMentions(text).map((mention) => ({
    ...mention,
    resolved: resolved.has(`${mention.kind}:${mention.name.toLocaleLowerCase()}`),
  }));
}

export function handleNekMentionClick(
  mention: NekMentionHighlight,
  targets: readonly NekMentionTargetInfo[],
  callbacks: { onOpenSkill: (location: string) => void; onShowAgentType: (name: string) => void },
): boolean {
  if (!mention.resolved) return false;
  const target = targets.find(
    (candidate) =>
      candidate.kind === mention.kind &&
      candidate.name.toLocaleLowerCase() === mention.name.toLocaleLowerCase(),
  );
  if (!target) return false;
  if (target.kind === "skill" && target.location) callbacks.onOpenSkill(target.location);
  else if (target.kind === "agent") callbacks.onShowAgentType(target.name);
  else return false;
  return true;
}

export function mentionQueryForCursor(textBeforeCaret: string): string | undefined {
  return mentionQuery(textBeforeCaret);
}

export interface MentionTargetsCache {
  load: (key: string, signal?: AbortSignal) => Promise<readonly NekMentionTargetInfo[]>;
  clear: (key?: string) => void;
}

export function createMentionTargetsCache(
  fetchTargets: (key: string, signal?: AbortSignal) => Promise<readonly NekMentionTargetInfo[]>,
  options: { now?: () => number; ttlMs?: number; maxEntries?: number } = {},
): MentionTargetsCache {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? NEK_MENTION_TARGET_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? NEK_MENTION_TARGET_CACHE_LIMIT;
  const entries = new Map<string, { value: readonly NekMentionTargetInfo[]; expiresAt: number }>();
  return {
    async load(key, signal) {
      const cached = entries.get(key);
      if (cached && cached.expiresAt > now()) {
        entries.delete(key);
        entries.set(key, cached);
        return cached.value;
      }
      const value = await fetchTargets(key, signal);
      entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
      return value;
    },
    clear(key) {
      if (key === undefined) entries.clear();
      else entries.delete(key);
    },
  };
}
