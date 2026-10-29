import { describe, expect, it } from "vitest";
import { mentionQuery } from "@zcode/shared/nek-protocol";
import {
  buildNekMentionCandidates,
  buildNekMentionReplacement,
  createMentionTargetsCache,
  getNekMentionHighlights,
  handleNekMentionClick,
  serializeNekMentionCandidate,
  type NekMentionFile,
} from "./nekMentionLogic.js";

const targets = [
  { kind: "agent" as const, name: "explorer" },
  { kind: "agent" as const, name: "alpha" },
  { kind: "skill" as const, name: "pdf", location: "/skills/pdf/SKILL.md" },
  { kind: "skill" as const, name: "review" },
];
const files: NekMentionFile[] = [
  { path: "src/main.ts" },
  { path: "README.md" },
  { path: "docs/space name.md" },
];

describe("nek mention logic", () => {
  it("MN-1/MN-2/MN-4: orders agent, skill, then file and filters kind prefixes", () => {
    expect(buildNekMentionCandidates("", targets, files).map((item) => item.label)).toEqual([
      "agent:alpha",
      "agent:explorer",
      "skill:pdf",
      "skill:review",
      "docs/space name.md",
      "README.md",
      "src/main.ts",
    ]);
    expect(buildNekMentionCandidates("agent:ex", targets, files).map((item) => item.label)).toEqual(
      ["agent:explorer"],
    );
    expect(buildNekMentionCandidates("skill:p", targets, files).map((item) => item.label)).toEqual([
      "skill:pdf",
    ]);
  });

  it("MN-3: applies independent candidate caps", () => {
    const manyAgents = Array.from({ length: 12 }, (_, index) => ({
      kind: "agent" as const,
      name: `agent-${index}`,
    }));
    const manySkills = Array.from({ length: 12 }, (_, index) => ({
      kind: "skill" as const,
      name: `skill-${index}`,
    }));
    const manyFiles = Array.from({ length: 40 }, (_, index) => ({ path: `file-${index}.ts` }));
    const result = buildNekMentionCandidates("", [...manyAgents, ...manySkills], manyFiles);
    expect(result.filter((item) => item.kind === "agent")).toHaveLength(8);
    expect(result.filter((item) => item.kind === "skill")).toHaveLength(8);
    expect(result.filter((item) => item.kind === "file")).toHaveLength(30);
  });

  it("MN-trigger: mirrors shared mentionQuery for boundaries and prefixes", () => {
    const cases: Array<[string, string | undefined]> = [
      ["@", ""],
      ["before @agent:ex", "agent:ex"],
      ["before @skill:pdf", "skill:pdf"],
      ["user@skill:pdf", undefined],
      ["a/@agent:ex", undefined],
      ["x.@skill:pdf", undefined],
      ["( @agent:one", "agent:one"],
    ];
    for (const [text, expected] of cases) expect(mentionQuery(text)).toBe(expected);
  });

  it("MN-A1/MN-A2: replacements use plain text and quote paths with spaces like nek", () => {
    const agent = buildNekMentionCandidates("agent:ex", targets, files)[0];
    const file = buildNekMentionCandidates("docs", targets, files).find(
      (item) => item.kind === "file",
    );
    expect(agent && buildNekMentionReplacement("hello @agent:ex", agent)).toEqual({
      start: 6,
      end: 15,
      text: "@agent:explorer ",
      caretOffset: 22,
    });
    expect(file && buildNekMentionReplacement("@docs", file)?.text).toBe('@"docs/space name.md" ');
    expect(file && serializeNekMentionCandidate(file)).toBe('@"docs/space name.md"');
  });

  it("MN-A3/MN-A4/MN-A5: serializes exact text, resolves highlights, and routes clicks", () => {
    const text = "@agent:alpha @skill:pdf @skill:missing";
    const highlights = getNekMentionHighlights(text, targets);
    expect(highlights.map((item) => item.resolved)).toEqual([true, true, false]);
    expect(
      serializeNekMentionCandidate({
        kind: "agent",
        name: "alpha",
        label: "agent:alpha",
        insertText: "@agent:alpha ",
      }),
    ).toBe("@agent:alpha");
    const opened: string[] = [];
    const shown: string[] = [];
    expect(
      handleNekMentionClick(highlights[1]!, targets, {
        onOpenSkill: (path) => opened.push(path),
        onShowAgentType: (name) => shown.push(name),
      }),
    ).toBe(true);
    expect(opened).toEqual(["/skills/pdf/SKILL.md"]);
    expect(
      handleNekMentionClick(highlights[2]!, targets, {
        onOpenSkill: () => undefined,
        onShowAgentType: () => undefined,
      }),
    ).toBe(false);
    expect(shown).toEqual([]);
  });

  it("MN-5: target cache expires after 30 seconds and is bounded", async () => {
    let now = 0;
    let calls = 0;
    const cache = createMentionTargetsCache(
      async () => {
        calls += 1;
        return targets;
      },
      { now: () => now, maxEntries: 1 },
    );
    await cache.load("one");
    await cache.load("one");
    expect(calls).toBe(1);
    now = 30_000;
    await cache.load("one");
    expect(calls).toBe(2);
    await cache.load("two");
    await cache.load("one");
    expect(calls).toBe(4);
  });
});
