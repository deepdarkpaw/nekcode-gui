/** nek v0.5.1: core/resource-loader.ts (context files) and core/footer-data-provider.ts (findGitPaths). */
import { realpath } from "node:fs/promises";
import {
  NEK_INSTRUCTION_FILE_NAMES,
  type NekConfigDiagnostic,
  type NekConfigScope,
  type NekInstructionFile,
  type NekInstructionsView,
} from "@zcode/shared/nek-protocol";
import { stripBom } from "../nek-agent/config/nekConfigDocuments.js";
import { writeTextDocument } from "./documents.js";
import { conflict, validationError } from "./errors.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import { instructionsDir, targetPaths } from "./paths.js";
import { ABSENT_REVISION, encodeRevision, sameRevision } from "./revision.js";

const MAX_INSTRUCTION_BYTES = 1024 * 1024;
const MAX_GIT_METADATA_BYTES = 8 * 1024;
const MAX_ANCESTOR_DIRS = 128;
const DEFAULT_FILENAME = "AGENTS.md";

type Report = (path: string, error: unknown) => void;
type Paths = ReturnType<typeof targetPaths>;
interface InstructionDocument extends NekInstructionFile {
  content: string;
  revision: string;
}
interface DirectoryContext {
  active?: InstructionDocument;
  ignored: NekInstructionFile[];
}
interface Location {
  executor: NekConfigHostExecutor;
  agentDir: string;
  scope: NekConfigScope;
  cwd?: string;
  logger?: { warn: (...args: unknown[]) => void };
}

function fileRef({ path, filename }: NekInstructionFile): NekInstructionFile {
  return { path, filename };
}

/** Core picks the first readable regular file, then keeps going in other directories. */
async function readDirectoryContext(
  executor: NekConfigHostExecutor,
  paths: Paths,
  dir: string,
  report: Report,
  includeIgnored = false,
): Promise<DirectoryContext> {
  const ignored: NekInstructionFile[] = [];
  let active: InstructionDocument | undefined;
  let directoryNames: string[] | undefined;
  const platform = executor.platform();
  for (const candidate of NEK_INSTRUCTION_FILE_NAMES) {
    let path = paths.join(dir, candidate);
    try {
      const info = await executor.stat(path);
      if (!info || info.isDirectory) continue;
      let filename: string = candidate;
      // Exact spelling is for the editor, not for precedence. On case-insensitive volumes
      // `AGENTS.md` and `AGENTS.MD` can name the same file; never show it as shadowing itself.
      if (platform === "win32" || platform === "darwin") {
        directoryNames ??= (await executor.listDir(dir)).map(({ name }) => name);
        if (!directoryNames.includes(candidate)) {
          filename =
            directoryNames.find((name) => name.toLowerCase() === candidate.toLowerCase()) ??
            candidate;
          path = paths.join(dir, filename);
        }
      }
      if (active) {
        if (path !== active.path && !ignored.some((file) => file.path === path))
          ignored.push({ path, filename });
        continue;
      }
      const content = await executor.readResourceFile(path, MAX_INSTRUCTION_BYTES);
      active = { path, filename, content, revision: encodeRevision(info, content) };
      if (!includeIgnored) break;
    } catch (error) {
      report(path, error);
    }
  }
  return { active, ignored };
}

function ancestorsOf(paths: Paths, cwd: string): string[] {
  const result: string[] = [];
  let dir = cwd;
  while (paths.dirname(dir) !== dir) {
    dir = paths.dirname(dir);
    if (result.length >= MAX_ANCESTOR_DIRS)
      throw validationError(`Too many instruction ancestors: ${cwd}`);
    result.push(dir);
  }
  return result;
}

async function findLinkedGitPaths(
  executor: NekConfigHostExecutor,
  paths: Paths,
  dirs: readonly string[],
  report: Report,
) {
  for (const repoDir of dirs) {
    const dotGit = paths.join(repoDir, ".git");
    try {
      const info = await executor.stat(dotGit);
      if (!info) continue;
      if (info.isDirectory) return;
      const content = (await executor.readResourceFile(dotGit, MAX_GIT_METADATA_BYTES)).trim();
      if (!content.startsWith("gitdir: ")) continue;
      const gitDir = paths.resolve(repoDir, content.slice(8).trim());
      if (!(await executor.stat(paths.join(gitDir, "HEAD")))) return;
      const commondir = paths.join(gitDir, "commondir");
      if (!(await executor.stat(commondir))) return;
      const common = (await executor.readResourceFile(commondir, MAX_GIT_METADATA_BYTES)).trim();
      return { repoDir, commonGitDir: paths.resolve(gitDir, common) };
    } catch (error) {
      report(dotGit, error);
      return;
    }
  }
}

function comparisonKey(paths: Paths, path: string): string {
  return paths.sep === "\\" ? path.toLowerCase() : path;
}

async function canonicalPath(local: boolean, path: string): Promise<string> {
  // gui-server uses a local executor on its own machine; direct SSH executors only expose lexical paths.
  if (!local) return path;
  try {
    return await realpath(path);
  } catch {
    return path; // Same as nek's canonicalizePath when the path has no realpath.
  }
}

async function worktreeShadowedFile(
  executor: NekConfigHostExecutor,
  paths: Paths,
  dirs: readonly string[],
  getFile: (dir: string) => Promise<NekInstructionFile | undefined>,
  local: boolean,
  report: Report,
) {
  const git = await findLinkedGitPaths(executor, paths, dirs, report);
  if (!git) return;
  const commonGitDir = await canonicalPath(local, git.commonGitDir);
  const worktreeRoot = await canonicalPath(local, git.repoDir);
  const mainRepoRoot = paths.dirname(commonGitDir);
  const relative = paths.relative(mainRepoRoot, worktreeRoot);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative)
  )
    return;
  const mainDotGit = await canonicalPath(local, paths.join(mainRepoRoot, ".git"));
  if (comparisonKey(paths, mainDotGit) !== comparisonKey(paths, commonGitDir)) return;
  const loaded = await getFile(git.repoDir);
  return loaded && paths.join(mainRepoRoot, loaded.filename);
}

async function projectAncestorFiles(
  executor: NekConfigHostExecutor,
  paths: Paths,
  cwd: string,
  agentDir: string,
  active: InstructionDocument | undefined,
  local: boolean,
  report: Report,
): Promise<NekInstructionFile[]> {
  const ancestors = ancestorsOf(paths, cwd);
  // Cache only selected file references, not the contents of each ancestor.
  const selected = new Map<string, NekInstructionFile | undefined>([
    [cwd, active && fileRef(active)],
  ]);
  const getFile = async (dir: string) => {
    if (!selected.has(dir)) {
      const { active: file } = await readDirectoryContext(executor, paths, dir, report);
      selected.set(dir, file && fileRef(file));
    }
    return selected.get(dir);
  };
  const global = await getFile(agentDir);
  const shadowed = await worktreeShadowedFile(
    executor,
    paths,
    [cwd, ...ancestors],
    getFile,
    local,
    report,
  );
  const seen = new Set([global?.path, active?.path]);
  const files: NekInstructionFile[] = [];
  for (const dir of ancestors) {
    const file = await getFile(dir);
    if (!file || seen.has(file.path)) continue;
    if (
      shadowed &&
      comparisonKey(paths, await canonicalPath(local, file.path)) === comparisonKey(paths, shadowed)
    )
      continue;
    seen.add(file.path);
    files.push(file);
  }
  return files.reverse();
}

function destination(
  paths: Paths,
  directory: string,
  active?: InstructionDocument,
): InstructionDocument {
  return (
    active ?? {
      path: paths.join(directory, DEFAULT_FILENAME),
      filename: DEFAULT_FILENAME,
      revision: ABSENT_REVISION,
      content: "",
    }
  );
}

export async function readInstructionsDocument({
  executor,
  agentDir,
  scope,
  cwd,
  logger,
  local,
}: Location & { local: boolean }): Promise<NekInstructionsView> {
  const paths = targetPaths(agentDir);
  const dir = instructionsDir({ agentDir }, scope, cwd);
  const diagnostics: NekConfigDiagnostic[] = [];
  const report: Report = (file, error) => {
    const message = error instanceof Error ? error.message : String(error);
    diagnostics.push({ file, message, severity: "warning" });
    logger?.warn("could not read nek instruction file", file, error);
  };
  const { active, ignored } = await readDirectoryContext(executor, paths, dir, report, true);
  const ancestors =
    scope === "project"
      ? await projectAncestorFiles(
          executor,
          paths,
          dir,
          paths.normalize(agentDir),
          active,
          local,
          report,
        )
      : [];
  const file = destination(paths, dir, active);
  return { ...file, content: stripBom(file.content), ignored, ancestors, diagnostics };
}

export async function writeInstructionsDocument({
  executor,
  agentDir,
  scope,
  cwd,
  logger,
  content,
  expected,
}: Location & {
  content: string;
  expected: { path: string; revision: string };
}): Promise<{ path: string; revision: string }> {
  const paths = targetPaths(agentDir);
  const dir = instructionsDir({ agentDir }, scope, cwd);
  const { active } = await readDirectoryContext(executor, paths, dir, (path, error) => {
    logger?.warn("could not read nek instruction file", path, error);
  });
  const file = destination(paths, dir, active);
  if (file.path !== expected.path || !sameRevision(file.revision, expected.revision))
    throw conflict(expected.path);
  const text =
    file.content.startsWith("\ufeff") && !content.startsWith("\ufeff")
      ? `\ufeff${content}`
      : content;
  if (Buffer.byteLength(text) > MAX_INSTRUCTION_BYTES)
    throw validationError(
      `Instruction file exceeds ${MAX_INSTRUCTION_BYTES / 1024} KB: ${file.path}`,
    );
  if (active)
    return { path: file.path, revision: await writeTextDocument(executor, file.path, text) };
  // A default path must never overwrite a new, unreadable, non-regular or otherwise occupied file.
  try {
    await executor.writeResourceFile(file.path, text, true);
  } catch (error) {
    if ((await executor.resourceEntryKind(file.path)) !== null) throw conflict(file.path);
    throw error;
  }
  const info = await executor.stat(file.path);
  if (!info) throw conflict(file.path);
  return { path: file.path, revision: encodeRevision(info, text) };
}
