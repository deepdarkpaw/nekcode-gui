import {
  questionAnswersDisplaySchema,
  subagentIdentityDisplaySchema,
  type ToolResultDisplay,
} from "@zcode/shared/zcode-protocol-v4";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Count the producer's patch in one pass, consuming hunk lengths so SQL `---` lines stay data. */
function patchStat(patch: string) {
  let oldLeft = 0;
  let newLeft = 0;
  let added = 0;
  let removed = 0;
  let path: string | undefined;
  let sawHunk = false;
  for (const line of patch.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      if (oldLeft || newLeft) throw new Error("Incomplete nek edit patch hunk");
      oldLeft = Number(hunk[1] ?? 1);
      newLeft = Number(hunk[2] ?? 1);
      sawHunk = true;
      continue;
    }
    if (oldLeft === 0 && newLeft === 0) {
      if (line.startsWith("+++ ")) {
        if (path !== undefined) throw new Error("nek edit result must contain one file patch");
        path = line.slice(4).split("\t")[0]?.replace(/^b\//, "");
      }
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      added++;
      newLeft--;
    } else if (line.startsWith("-")) {
      removed++;
      oldLeft--;
    } else if (line.startsWith(" ")) {
      oldLeft--;
      newLeft--;
    } else throw new Error("Invalid nek edit patch hunk line");
    if (oldLeft < 0 || newLeft < 0) throw new Error("Invalid nek edit patch hunk length");
  }
  if (oldLeft || newLeft || !sawHunk) throw new Error("Incomplete nek edit patch");
  return { added, removed, path };
}

/** Whitelist durable tool details once; never parse human-readable answer prose in the renderer. */
export function projectNekToolDetails(
  toolName: string,
  details: unknown,
  input: unknown,
): ToolResultDisplay | undefined {
  const data = record(details);
  if (!data) return undefined;
  if (toolName === "subagent" && data.subagent !== undefined) {
    const child = record(data.subagent);
    return subagentIdentityDisplaySchema.parse({
      kind: "subagent_identity",
      id: child?.id,
      type: child?.type,
      model: child?.model,
    });
  }
  if (toolName === "ask_question" && data.answers !== undefined) {
    return questionAnswersDisplaySchema.parse({ kind: "question_answers", answers: data.answers });
  }
  if (toolName !== "edit" || typeof data.patch !== "string") return undefined;
  const stat = patchStat(data.patch);
  const args = record(input);
  const path = args?.file_path ?? args?.path ?? stat.path;
  if (typeof path !== "string" || !path) throw new Error("nek edit result has no file path");
  return {
    kind: "file_diff",
    filePath: path,
    additions: stat.added,
    deletions: stat.removed,
    patch: data.patch,
    structuredPatch: [],
  };
}
