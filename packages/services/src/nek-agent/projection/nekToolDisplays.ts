import { parsePatchFiles } from "@pierre/diffs";
import {
  questionAnswersDisplaySchema,
  type ToolResultDisplay,
} from "@zcode/shared/zcode-protocol-v4";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Whitelist durable tool details once; never parse human-readable answer prose in the renderer. */
export function projectNekToolDetails(
  toolName: string,
  details: unknown,
  input: unknown,
): ToolResultDisplay | undefined {
  const data = record(details);
  if (!data) return undefined;
  if (toolName === "ask_question" && data.answers !== undefined) {
    return questionAnswersDisplaySchema.parse({ kind: "question_answers", answers: data.answers });
  }
  if (toolName !== "edit" || typeof data.patch !== "string") return undefined;
  const files = parsePatchFiles(data.patch, undefined, true).flatMap((patch) => patch.files);
  if (files.length !== 1) throw new Error("nek edit result must contain one file patch");
  const file = files[0]!;
  const args = record(input);
  const path = args?.file_path ?? args?.path ?? file.name;
  if (typeof path !== "string" || !path) throw new Error("nek edit result has no file path");
  const stat = file.hunks.reduce(
    (sum, hunk) => ({
      added: sum.added + hunk.additionLines,
      removed: sum.removed + hunk.deletionLines,
    }),
    { added: 0, removed: 0 },
  );
  return {
    kind: "file_diff",
    filePath: path,
    additions: stat.added,
    deletions: stat.removed,
    patch: data.patch,
    structuredPatch: [],
  };
}
