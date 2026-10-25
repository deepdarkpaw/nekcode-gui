import assert from "node:assert/strict";
import test from "node:test";
import {
  findAllMentions,
  findMentions,
  formatMention,
  matchMentionTargets,
  mentionHighlights,
  mentionQuery,
  NEK_MENTION_QUERY_REGEX,
  NEK_MENTION_REGEX,
  nekFuzzyFilter,
  nekFuzzyMatch,
} from "@zcode/shared/nek-protocol";
import type { MentionTarget } from "@zcode/shared/nek-protocol";

/**
 * `@agent:` / `@skill:` 点名的语义镜像。
 *
 * 正则必须与 nek 逐字一致（`core/mentions.ts`、`modes/interactive/mention-autocomplete.ts`），
 * 否则同一段文字在终端和 GUI 里会被识别成不同的点名。用例沿用 nek 自己的
 * `test/mention-autocomplete.test.ts` 夹具，保证两边行为对齐。
 */

const agents: MentionTarget[] = [
  { kind: "agent", name: "generalPurpose", description: "writable" },
  { kind: "agent", name: "explorer", description: "read-only" },
];
const skills: MentionTarget[] = [{ kind: "skill", name: "pdf", description: "PDF files" }];
const targets: MentionTarget[] = [...agents, ...skills];

/** nek `MENTION_REGEX` 的 source 原文。 */
const NEK_MENTION_SOURCE = "(?<![\\w.@/-])@(agent|skill):([\\w.-]*\\w)";

/** nek `MENTION_QUERY_REGEX` 的 source 原文（反引号用 charCode 拼，免得模板/引号互相打架）。 */
const BACKTICK = String.fromCharCode(96);
const NEK_MENTION_QUERY_SOURCE = `(?:^|[\\s=<${BACKTICK}]|[^\\P{P}@./\\\\_-])@([^\\s"'${BACKTICK}@]*)$`;

test("regexes are byte-identical to nek's", () => {
  assert.equal(NEK_MENTION_REGEX.source, NEK_MENTION_SOURCE);
  assert.equal(NEK_MENTION_REGEX.flags, "g");
  assert.equal(NEK_MENTION_QUERY_REGEX.source, NEK_MENTION_QUERY_SOURCE);
  assert.equal(NEK_MENTION_QUERY_REGEX.flags, "u");
});

test("formatMention renders the canonical token", () => {
  assert.equal(formatMention("agent", "explorer"), "@agent:explorer");
  assert.equal(formatMention("skill", "pdf"), "@skill:pdf");
});

test("findAllMentions reports spans and only token-boundary mentions", () => {
  const text = "用 @agent:explorer 看看，然后（@skill:pdf）处理";
  const mentions = findAllMentions(text);
  assert.deepEqual(
    mentions.map((mention) => [mention.kind, mention.name, text.slice(mention.start, mention.end)]),
    [
      ["agent", "explorer", "@agent:explorer"],
      ["skill", "pdf", "@skill:pdf"],
    ],
  );
});

test("addresses and path segments are not mentions", () => {
  const text = "邮箱 user@skill:mail 和 a/@agent:x 不算";
  assert.deepEqual(findAllMentions(text), []);
  assert.deepEqual(findMentions(text, "agent"), []);
  assert.deepEqual(findMentions(text, "skill"), []);
});

test("names keep dots and hyphens but not trailing punctuation", () => {
  assert.deepEqual(findMentions("ask @agent:gpt-6.1-sol-worker.", "agent"), ["gpt-6.1-sol-worker"]);
  assert.deepEqual(findMentions("@skill:pdf,", "skill"), ["pdf"]);
  // 名字必须以单词字符结尾：`@skill:.` 与 `@skill:-` 都不是点名。
  assert.deepEqual(findAllMentions("@skill:. @skill:-"), []);
});

test("findMentions dedupes per kind in first-mention order", () => {
  const text = "@skill:pdf 和 @agent:explorer 和 @skill:pdf 再 @skill:docx";
  assert.deepEqual(findMentions(text, "skill"), ["pdf", "docx"]);
  assert.deepEqual(findMentions(text, "agent"), ["explorer"]);
});

test("mentionHighlights exposes the same spans for the renderer", () => {
  const text = "@agent:explorer 再 @skill:pdf";
  assert.deepEqual(
    mentionHighlights(text).map((highlight) => [
      highlight.kind,
      text.slice(highlight.start, highlight.end),
    ]),
    [
      ["agent", "@agent:explorer"],
      ["skill", "@skill:pdf"],
    ],
  );
});

test("mentionQuery reads the @ token before the cursor", () => {
  assert.equal(mentionQuery("@"), "");
  assert.equal(mentionQuery("see @exp"), "exp");
  assert.equal(mentionQuery("看（@agent:ex"), "agent:ex");
  assert.equal(mentionQuery("x=@sk"), "sk");
  assert.equal(mentionQuery(`${BACKTICK}@pdf`), "pdf");
});

test("mentionQuery ignores addresses, path segments and quoted paths", () => {
  assert.equal(mentionQuery("user@ag"), undefined);
  assert.equal(mentionQuery("src/@ag"), undefined);
  assert.equal(mentionQuery('@"src/fo'), undefined);
  assert.equal(mentionQuery("hello"), undefined);
  assert.equal(mentionQuery("@a b"), undefined);
});

test("matchMentionTargets prefers bare-name matches, then kind:name matches", () => {
  // 裸 `@` 列出全部目标，保持输入顺序（子代理在前、skill 在后由调用方决定）。
  assert.deepEqual(
    matchMentionTargets(targets, "").map((target) => formatMention(target.kind, target.name)),
    ["@agent:generalPurpose", "@agent:explorer", "@skill:pdf"],
  );
  // 按名字：`exp` 命中 explorer。
  assert.deepEqual(
    matchMentionTargets(targets, "exp").map((target) => formatMention(target.kind, target.name)),
    ["@agent:explorer"],
  );
  // 按 kind:name：`skill:pd` 只命中 skill。
  assert.deepEqual(
    matchMentionTargets(targets, "skill:pd").map((target) =>
      formatMention(target.kind, target.name),
    ),
    ["@skill:pdf"],
  );
  // 名字匹配已经出现的目标不会在第二轮里重复。
  const duplicated = matchMentionTargets(targets, "pdf");
  assert.equal(duplicated.filter((target) => target.name === "pdf").length, 1);
  assert.deepEqual(matchMentionTargets(targets, "zzz"), []);
});

test("fuzzy matching mirrors pi-tui scores and the alphanumeric swap", () => {
  // 完全相等额外 -100；前缀匹配优于中间匹配。
  assert.ok(nekFuzzyMatch("pdf", "pdf").score < nekFuzzyMatch("pdf", "a-pdf-x").score);
  // 子序列匹配（非连续）也算命中。
  assert.equal(nekFuzzyMatch("pdr", "pdf-reader").matches, true);
  // 字母数字交换：`pdf2` ↔ `2pdf`，得分 +5。
  assert.equal(nekFuzzyMatch("pdf2", "2pdf").matches, true);
  assert.equal(nekFuzzyMatch("pdf2", "2pdf").score, nekFuzzyMatch("2pdf", "2pdf").score + 5);
  // 词边界加分：`ex` 在 `explorer` 开头命中，比在词中间命中更优。
  assert.ok(nekFuzzyMatch("ex", "explorer").score < nekFuzzyMatch("ex", "text-explorer").score);
  assert.equal(nekFuzzyMatch("zzz", "explorer").matches, false);
});

test("fuzzy filter splits on whitespace and slashes and keeps input order on ties", () => {
  const items = ["beta-1", "alpha-2", "alpha-1"];
  // 多个 token 必须全部命中。
  assert.deepEqual(
    nekFuzzyFilter(items, "alpha 1", (item) => item),
    ["alpha-1"],
  );
  // 斜杠同样切分。
  assert.deepEqual(
    nekFuzzyFilter(items, "alpha/2", (item) => item),
    ["alpha-2"],
  );
  // 空查询原样返回。
  assert.deepEqual(
    nekFuzzyFilter(items, "  ", (item) => item),
    items,
  );
  // 同分保持输入顺序（stable sort）。
  assert.deepEqual(
    nekFuzzyFilter(["ab", "ac"], "a", (item) => item),
    ["ab", "ac"],
  );
});

test("mention targets carry an optional location for the RPC response", () => {
  // `get_mention_targets` 的 data 形状：kind/name/description/location。
  const info = {
    kind: "skill" as const,
    name: "pdf",
    description: "PDF files",
    location: "/skills/pdf/SKILL.md",
  };
  assert.equal(formatMention(info.kind, info.name), "@skill:pdf");
  assert.deepEqual(
    matchMentionTargets([info], "pdf").map((target) => target.name),
    ["pdf"],
  );
});
