import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGitService } from "../src/git/gitService.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}
async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), "nek-git-review-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.name", "test");
  git(cwd, "config", "user.email", "test@localhost");
  git(cwd, "config", "core.autocrlf", "false");
  return cwd;
}

test("Git review merges A→B→A edits and staged/unstaged changes into HEAD→working-tree net diffs", async () => {
  const cwd = await repository();
  const service = createGitService();
  try {
    await writeFile(join(cwd, "a.txt"), "original\n");
    await writeFile(join(cwd, "b.txt"), "original\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "baseline");
    await writeFile(join(cwd, "a.txt"), "temporary\n");
    git(cwd, "add", "a.txt");
    await writeFile(join(cwd, "b.txt"), "other\n");
    await writeFile(join(cwd, "a.txt"), "final\nextra\n");
    const review = await service.getWorktreeReview({ workspacePath: cwd });
    assert.equal(review.isRepository, true);
    assert.deepEqual(
      review.files.map((file) => [file.workspaceRelativePath, file.added, file.removed]),
      [
        ["a.txt", 2, 1],
        ["b.txt", 1, 1],
      ],
    );
    const diff = await service.getDiff({ workspacePath: cwd, path: "a.txt", compareToHead: true });
    assert.equal(diff.availability, "patch");
    assert.match(diff.patch!, /-original/);
    assert.match(diff.patch!, /\+final/);
    assert.doesNotMatch(diff.patch!, /temporary/);
    await writeFile(join(cwd, "a.txt"), "original\n");
    const cancelled = await service.getWorktreeReview({ workspacePath: cwd });
    assert.deepEqual(
      cancelled.files.map((file) => file.workspaceRelativePath),
      ["b.txt"],
    );
    const unchanged = await service.getDiff({
      workspacePath: cwd,
      path: "a.txt",
      compareToHead: true,
    });
    assert.equal(
      unchanged.patch,
      null,
      "staged changes cancelled in the worktree are not shown as file creation",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("new files, ignored files, binary files and workspace subdirectory scope", async () => {
  const cwd = await repository();
  const service = createGitService();
  try {
    await mkdir(join(cwd, "sub"));
    await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-qm", "baseline");
    await writeFile(join(cwd, "outside.txt"), "outside\n");
    await writeFile(join(cwd, "sub", "new [1].txt"), "new\nfile\n");
    await writeFile(join(cwd, "sub", "ignored.txt"), "ignored\n");
    await writeFile(join(cwd, "sub", "binary.bin"), Buffer.from([0, 1, 2]));
    const workspacePath = join(cwd, "sub");
    const review = await service.getWorktreeReview({ workspacePath });
    assert.deepEqual(review.files.map((file) => file.workspaceRelativePath).sort(), [
      "binary.bin",
      "new [1].txt",
    ]);
    const text = await service.getDiff({ workspacePath, path: "new [1].txt", compareToHead: true });
    assert.equal(text.availability, "patch");
    assert.match(text.patch!, /\+new/);
    const binary = await service.getDiff({
      workspacePath,
      path: "binary.bin",
      compareToHead: true,
    });
    assert.equal(binary.availability, "binary");
    await assert.rejects(
      service.getDiff({
        workspacePath,
        path: join(cwd, "..", "outside-repo.txt"),
        compareToHead: true,
      }),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unborn repositories compare working files against empty, without creating a commit or changing the index", async () => {
  const cwd = await repository();
  const service = createGitService();
  try {
    await writeFile(join(cwd, "new.txt"), "staged\n");
    git(cwd, "add", "new.txt");
    await writeFile(join(cwd, "new.txt"), "actual\nfinal\n");
    const indexBefore = git(cwd, "ls-files", "--stage");
    const review = await service.getWorktreeReview({ workspacePath: cwd });
    assert.equal(review.files[0]?.added, 2);
    const diff = await service.getDiff({
      workspacePath: cwd,
      path: "new.txt",
      compareToHead: true,
    });
    assert.match(diff.patch!, /\+actual/);
    assert.doesNotMatch(diff.patch!, /staged/);
    assert.equal(git(cwd, "ls-files", "--stage"), indexBefore);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("non-repository is reported explicitly instead of fabricating a diff", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "nek-no-git-"));
  try {
    const review = await createGitService().getWorktreeReview({ workspacePath: cwd });
    assert.equal(review.isRepository, false);
    assert.deepEqual(review.files, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
