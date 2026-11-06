import { resolve } from "node:path";
import type { GitDiffResult, GitWorktreeReview } from "@zcode/shared";
import {
  DEFAULT_GIT_DIFF_BYTES,
  DEFAULT_GIT_DIFF_TIMEOUT_MS,
  getGitNullDevicePath,
  isPathInWorkspaceScope,
  toWorkspaceRelativeGitPath,
} from "../config.js";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import type { GitResolvedRepository, GitStatusSnapshot } from "./gitCliTypes.js";
import {
  buildUntrackedStats,
  buildUntrackedTextDiffResult,
  ensureGitCommandSucceeded,
  fileExists,
  parseNumstat,
  toDiffResult,
} from "./gitCliHelpers.js";

/** A missing HEAD is valid for an unborn repository, not a reason to guess an index baseline. */
async function readHead(provider: GitCommandProvider, repoRoot: string): Promise<string | null> {
  const result = await provider.run({
    cwd: repoRoot,
    args: ["rev-parse", "--verify", "--quiet", "HEAD"],
  });
  ensureGitCommandSucceeded("git rev-parse HEAD", result, [0, 1]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** Read the final workspace state, never sum staged and unstaged operation statistics. */
export async function readWorktreeReview(
  provider: GitCommandProvider,
  status: GitStatusSnapshot,
): Promise<GitWorktreeReview> {
  const { resolution } = status;
  const result: GitWorktreeReview = {
    isGitAvailable: resolution.isGitAvailable,
    isRepository: resolution.isRepository,
    files: [],
  };
  if (!result.isGitAvailable || !result.isRepository) return result;
  const head = await readHead(provider, resolution.repoRoot);
  const stats = new Map(status.untrackedStats);
  if (head) {
    const diff = await provider.run({
      cwd: resolution.repoRoot,
      args: [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--numstat",
        "-z",
        head,
        "--",
      ],
    });
    ensureGitCommandSucceeded("git diff HEAD --numstat", diff);
    for (const [path, stat] of parseNumstat(diff.stdout)) stats.set(path, stat);
  } else {
    const existing = [];
    for (const entry of status.entries) {
      if (await fileExists(resolve(resolution.repoRoot, entry.path))) {
        existing.push({ ...entry, isUntracked: true });
      }
    }
    stats.clear();
    for (const [path, stat] of await buildUntrackedStats(resolution.repoRoot, existing))
      stats.set(path, stat);
  }
  for (const [path, stat] of stats) {
    if (!isPathInWorkspaceScope(path, resolution.workspaceInRepoPath)) continue;
    result.files.push({
      path: resolve(resolution.repoRoot, path),
      workspaceRelativePath: toWorkspaceRelativeGitPath(path, resolution.workspaceInRepoPath),
      added: stat.added,
      removed: stat.removed,
    });
  }
  return result;
}

/** Existing getDiff path validation runs before this HEAD→working-tree comparison. */
export async function readWorktreeFileDiff(
  provider: GitCommandProvider,
  resolution: GitResolvedRepository,
  repoRelativePath: string,
  absolutePath: string,
): Promise<GitDiffResult> {
  const head = await readHead(provider, resolution.repoRoot);
  if (head) {
    const result = await provider.run({
      cwd: resolution.repoRoot,
      args: [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        "--binary",
        head,
        "--",
        `:(literal)${repoRelativePath}`,
      ],
      timeoutMs: DEFAULT_GIT_DIFF_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_DIFF_BYTES,
    });
    if (!result.outputTruncated) ensureGitCommandSucceeded("git diff HEAD", result);
    const diff = toDiffResult(absolutePath, result, {
      emptySummary: "No net changes relative to HEAD.",
    });
    if (diff.availability !== "unavailable") return diff;
    const tracked = await provider.run({
      cwd: resolution.repoRoot,
      args: ["ls-tree", "--name-only", head, "--", `:(literal)${repoRelativePath}`],
    });
    ensureGitCommandSucceeded("git ls-tree HEAD", tracked);
    if (tracked.stdout.trim()) return diff;
  }
  if (!(await fileExists(absolutePath))) {
    return {
      path: absolutePath,
      availability: "unavailable",
      patch: null,
      beforeContent: null,
      afterContent: null,
    };
  }
  const text = await buildUntrackedTextDiffResult(
    absolutePath,
    repoRelativePath,
    DEFAULT_GIT_DIFF_BYTES,
  );
  if (text) return text;
  const result = await provider.run({
    cwd: resolution.repoRoot,
    args: [
      "diff",
      "--no-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--binary",
      "--",
      getGitNullDevicePath(),
      absolutePath,
    ],
    timeoutMs: DEFAULT_GIT_DIFF_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_GIT_DIFF_BYTES,
  });
  return toDiffResult(absolutePath, result, {
    allowedExitCodes: [0, 1],
    emptySummary: "No previewable net diff.",
  });
}
