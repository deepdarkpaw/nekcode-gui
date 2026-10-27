/**
 * nek 的 `@kind:name` 点名（`@agent:<子代理类型>`、`@skill:<skill 名>`）的镜像实现。
 *
 * 事实来源（`G:\coding\nekcode`，只读参考）：
 * - `packages/coding-agent/src/core/mentions.ts`（`MentionKind`、`Mention`、`MENTION_REGEX`、
 *   `findAllMentions`、`findMentions`、`formatMention`）；
 * - `packages/coding-agent/src/modes/interactive/mention-autocomplete.ts`（`MentionTarget`、
 *   `MENTION_QUERY_REGEX`、`mentionQuery`、`matchMentionTargets`）；
 * - `site/docs/guide/usage.md` 的「点名子代理和 Skill」一节（语义契约）。
 *
 * 正则与 nek **逐字一致**：GUI 只是复用语义，不能自己发明一套边界规则，否则同一段文字在
 * 终端和 GUI 里会被识别成不同的点名。nek 侧改正则时这里必须同步（见导出常量上的注释）。
 *
 * 不在此处的：`withMentionCompletions` / `toAutocompleteItem`（TUI 的 autocomplete 包装），
 * 它们依赖 `@earendil-works/pi-tui` 的输入框和补全 provider。GUI 的补全列表由 UI 层实现，
 * 只需要 `mentionQuery` + `matchMentionTargets` 这两个纯函数。
 */

/** 点名的两类目标。 */
export type MentionKind = "agent" | "skill";

export const NEK_MENTION_KINDS: readonly MentionKind[] = ["agent", "skill"];

/** 一处 `@kind:name` 及其在文本中的区间 `[start, end)`。 */
export interface Mention {
  kind: MentionKind;
  name: string;
  start: number;
  end: number;
}

/** 一个补全目标：子代理类型或 skill。 */
export interface MentionTarget {
  kind: MentionKind;
  name: string;
  description?: string;
}

/**
 * `get_mention_targets` 返回的目标：在 {@link MentionTarget} 之上带出资源位置
 * （agent 预设文件或 `SKILL.md`），供 GUI 打开文件。
 */
export interface NekMentionTargetInfo extends MentionTarget {
  location?: string;
}

/**
 * 点名只从 token 边界开始：`user@skill:x`、`a/@skill:x` 都不是点名。
 * 名字可以含点与连字符（`gpt-6.1-sol-worker`），但必须以单词字符结尾，
 * 所以句末标点不会被吞进名字。
 *
 * ⚠️ 与 nek `core/mentions.ts` 的 `MENTION_REGEX` 逐字一致，改这里必须同时改 nek。
 */
export const NEK_MENTION_REGEX = /(?<![\w.@/-])@(agent|skill):([\w.-]*\w)/g;

/**
 * 光标前的 `@` token：行首，或空格 / `=` / `<` / 反引号 / 除路径与地址字符之外的标点之后。
 * 被引号包住的 `@"` 路径仍归文件补全。
 *
 * ⚠️ 与 nek `mention-autocomplete.ts` 的 `MENTION_QUERY_REGEX` 逐字一致。
 */
export const NEK_MENTION_QUERY_REGEX = /(?:^|[\s=<`]|[^\P{P}@./\\_-])@([^\s"'`@]*)$/u;

/** 点名的文本形式，例如 `@skill:pdf`。 */
export function formatMention(kind: MentionKind, name: string): string {
  return `@${kind}:${name}`;
}

/** `text` 里所有的 `@kind:name`，按出现顺序。 */
export function findAllMentions(text: string): Mention[] {
  return Array.from(text.matchAll(NEK_MENTION_REGEX), (match) => {
    const start = match.index;
    return {
      kind: match[1] as MentionKind,
      // 正则第二组至少含一个单词字符，所以这里的非空断言是安全的。
      name: match[2] as string,
      start,
      end: start + match[0].length,
    };
  });
}

/** `text` 里某一类的名字，按首次出现顺序去重。 */
export function findMentions(text: string, kind: MentionKind): string[] {
  const names = findAllMentions(text)
    .filter((mention) => mention.kind === kind)
    .map((mention) => mention.name);
  return [...new Set(names)];
}

/** 光标前 `@` 之后的查询串；光标不在 `@` token 内时返回 undefined。 */
export function mentionQuery(textBeforeCursor: string): string | undefined {
  return NEK_MENTION_QUERY_REGEX.exec(textBeforeCursor)?.[1];
}

/**
 * 按查询串挑目标：先按裸名字匹配，再补上整体 `kind:name` 形式的匹配
 * （所以 `@skill:pdf` 里输入 `skill:pd` 也能命中 `skill:pdf`）。
 */
export function matchMentionTargets(
  targets: readonly MentionTarget[],
  query: string,
): MentionTarget[] {
  const byName = nekFuzzyFilter([...targets], query, (target) => target.name);
  const matched = new Set(byName);
  const byToken = nekFuzzyFilter(
    targets.filter((target) => !matched.has(target)),
    query,
    (target) => `${target.kind}:${target.name}`,
  );
  return [...byName, ...byToken];
}

/** 模糊匹配结果：`score` 越小越好。 */
export interface NekFuzzyMatch {
  matches: boolean;
  score: number;
}

/**
 * 与 `@earendil-works/pi-tui` 的 `fuzzyMatch` 同算法的本地实现（GUI 不依赖 nek 的 TUI 包）。
 *
 * 差异：这里不导出 `FuzzyMatch` 这个名字（用 {@link NekFuzzyMatch}），其余分支、权值、
 * 字母/数字交换（`gpt6` 也能匹配 `6gpt`，得分 +5）与上游完全一致；上游若调整权值，
 * GUI 的排序会与终端略有不同，但匹配集合保持一致。
 */
export function nekFuzzyMatch(query: string, text: string): NekFuzzyMatch {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  const matchQuery = (normalizedQuery: string): NekFuzzyMatch => {
    if (normalizedQuery.length === 0) return { matches: true, score: 0 };
    if (normalizedQuery.length > textLower.length) return { matches: false, score: 0 };

    let queryIndex = 0;
    let score = 0;
    let lastMatchIndex = -1;
    let consecutiveMatches = 0;

    while (queryIndex < normalizedQuery.length) {
      const char = normalizedQuery[queryIndex] as string;
      const index = textLower.indexOf(char, lastMatchIndex + 1);
      if (index === -1) break;

      const isWordBoundary = index === 0 || /[\s\-_./:]/u.test(textLower[index - 1] as string);
      if (lastMatchIndex === index - 1) {
        consecutiveMatches += 1;
        score -= consecutiveMatches * 5;
      } else {
        consecutiveMatches = 0;
        if (lastMatchIndex >= 0) score += (index - lastMatchIndex - 1) * 2;
      }
      if (isWordBoundary) score -= 10;
      score += index * 0.1;

      lastMatchIndex = index;
      queryIndex += 1;
    }

    if (queryIndex < normalizedQuery.length) return { matches: false, score: 0 };
    if (normalizedQuery === textLower) score -= 100;
    return { matches: true, score };
  };

  const primary = matchQuery(queryLower);
  if (primary.matches) return primary;

  const alphaNumeric = /^(?<letters>[a-z]+)(?<digits>[0-9]+)$/u.exec(queryLower);
  const numericAlpha = /^(?<digits>[0-9]+)(?<letters>[a-z]+)$/u.exec(queryLower);
  const swappedQuery = alphaNumeric
    ? `${alphaNumeric.groups?.digits ?? ""}${alphaNumeric.groups?.letters ?? ""}`
    : numericAlpha
      ? `${numericAlpha.groups?.letters ?? ""}${numericAlpha.groups?.digits ?? ""}`
      : "";
  if (!swappedQuery) return primary;

  const swapped = matchQuery(swappedQuery);
  if (!swapped.matches) return primary;
  return { matches: true, score: swapped.score + 5 };
}

/**
 * 与 pi-tui 的 `fuzzyFilter` 同语义：查询按空白与 `/` 切成多个 token，全部命中才算匹配，
 * 按累计得分升序返回（同分保持输入顺序）。
 */
export function nekFuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
  if (!query.trim()) return items;
  const tokens = query
    .trim()
    .split(/[\s/]+/u)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return items;

  const results: Array<{ item: T; totalScore: number }> = [];
  for (const item of items) {
    const text = getText(item);
    let totalScore = 0;
    let allMatch = true;
    for (const token of tokens) {
      const match = nekFuzzyMatch(token, text);
      if (!match.matches) {
        allMatch = false;
        break;
      }
      totalScore += match.score;
    }
    if (allMatch) results.push({ item, totalScore });
  }
  results.sort((left, right) => left.totalScore - right.totalScore);
  return results.map((entry) => entry.item);
}

/**
 * 一段文本里的点名高亮区间（供 UI 直接渲染链接色）。
 *
 * 只是把 `findAllMentions` 的 `[start, end)` 原样给出；文本本身必须原样显示，
 * GUI 不得重写用户输入（`@agent:`/`@skill:` 的高亮完全由渲染层负责）。
 */
export function mentionHighlights(
  text: string,
): Array<{ kind: MentionKind; name: string; start: number; end: number }> {
  return findAllMentions(text);
}
