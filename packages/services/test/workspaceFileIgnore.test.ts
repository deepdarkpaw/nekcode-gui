import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import type { IFileService } from "../src/file/file.js";
import { createFileService } from "../src/file/fileService.js";
import {
  WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME,
  isWorkspaceFileSearchPathIgnored,
  loadWorkspaceFileSearchIgnoreRules,
} from "../src/file/workspaceFileIgnore.js";

/**
 * 回归：打开 / 搜索 / 列举 workspace 不能隐式创建 `.zcodiumignore`。
 *
 * Bug 原因：`loadWorkspaceFileSearchIgnoreRules` 在文件缺失时直接落盘（.gitignore 拷贝 /
 * 默认模板），而 list/search 的公共入口每次都调用它，于是用户仓库被写入一个从未保存过的
 * 规则文件（实测 Nekomangatranslator 里的内容就是自动模板）。
 * 修复后：缺失只是「内存合成规则」，唯一写入口是设置页保存；缓存指纹在文件缺失时跟随
 * `.gitignore`，否则编辑 gitignore 后旧索引会继续用过期规则。
 *
 * 全部用例走真实 `createFileService` 公共 list/search 路径；tmp 固定放在仓库 `.tmp/`。
 */

const ignoreFileName = WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME;
const TMP_ROOT = fileURLToPath(new URL("../../../.tmp/", import.meta.url));
const LIST_CHUNK_SIZE = 4_000;

interface Fixture {
  rootPath: string;
  ignorePath: string;
  cleanup: () => Promise<void>;
}

async function writeFixtureFiles(rootPath: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(rootPath, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

async function createFixture(files: Record<string, string>): Promise<Fixture> {
  await mkdir(TMP_ROOT, { recursive: true });
  const rootPath = await mkdtemp(join(TMP_ROOT, "workspace-file-ignore-"));
  await writeFixtureFiles(rootPath, files);
  return {
    rootPath,
    ignorePath: join(rootPath, ignoreFileName),
    cleanup: () => rm(rootPath, { recursive: true, force: true }),
  };
}

/** 规则编辑要把 mtime 推后：同毫秒写入 + 同体积内容会让 mtime:size 指纹保持不变。 */
async function rewriteRuleFile(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  const future = new Date(Date.now() + 5_000);
  await utimes(path, future, future);
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    (fileStat) => fileStat.isFile(),
    () => false,
  );
}

/** 真实公共 list 路径：按长度分块拉取 + 解码，返回相对路径。 */
async function listRelativePaths(service: IFileService, rootPath: string): Promise<string[]> {
  const totalLength = await service.listWorkspaceFilesLength({ rootPath });
  const chunks: string[] = [];
  for (let offset = 0; offset < totalLength; offset += LIST_CHUNK_SIZE) {
    chunks.push(
      await service.listWorkspaceFilesRange({ rootPath, offset, length: LIST_CHUNK_SIZE }),
    );
  }
  return unpackWorkspaceFileEntries(chunks.join(""), rootPath).map((entry) => entry.relativePath);
}

/** 真实公共 search 路径（Host 侧匹配，只回有界候选）。 */
async function searchRelativePaths(
  service: IFileService,
  rootPath: string,
  query: string,
): Promise<string[]> {
  const entries = await service.searchWorkspaceFiles({ rootPath, query, limit: 50 });
  return entries.map((entry) => entry.relativePath);
}

test("缺失 .zcodiumignore 时 list/search 不创建文件，.gitignore 与内置默认规则仍生效", async () => {
  const fixture = await createFixture({
    ".gitignore": "dist/\n",
    "keep.ts": "export const keep = 1;\n",
    "secret.ts": "export const secret = 1;\n",
    "src/app.ts": "export const app = 1;\n",
    "dist/bundle.js": "console.log('dist');\n",
    "node_modules/pkg/index.js": "module.exports = 1;\n",
  });
  const service = createFileService();
  try {
    // 搜索先跑：它是「打开 @ 面板」的入口，历史上正是它把文件写进用户仓库的那条路径。
    // 打分对绝对路径做子序列匹配，所以这里只断言入选/排除，不锁死整个结果集。
    const searchHits = await searchRelativePaths(service, fixture.rootPath, "app");
    assert.ok(searchHits.includes("src/app.ts"));
    assert.ok(!searchHits.includes("dist/bundle.js"), ".gitignore 规则必须在搜索路径生效");
    assert.equal(await fileExists(fixture.ignorePath), false, "搜索不能创建 .zcodiumignore");

    const listed = await listRelativePaths(service, fixture.rootPath);
    assert.ok(listed.includes("keep.ts"));
    assert.ok(listed.includes("secret.ts"));
    assert.ok(listed.includes("src/app.ts"));
    assert.ok(!listed.includes("dist/bundle.js"), ".gitignore 规则必须生效");
    assert.ok(!listed.includes("node_modules/pkg/index.js"), "内置默认规则必须生效");
    assert.ok(!listed.includes(ignoreFileName));
    assert.equal(
      await fileExists(fixture.ignorePath),
      false,
      "列举（含缓存命中路径）不能创建 .zcodiumignore",
    );

    // 设置页读取同样只读，并按契约返回 template 预览。
    const preview = await service.readWorkspaceFileSearchIgnore({ rootPath: fixture.rootPath });
    assert.equal(preview.source, "template");
    assert.ok(preview.content.includes("dist/"), "预览必须包含 .gitignore 拷贝");
    assert.ok(preview.content.includes("node_modules/"), "预览必须包含内置默认段");
    assert.equal(await fileExists(fixture.ignorePath), false, "读取预览不能创建文件");
  } finally {
    await fixture.cleanup();
  }
});

test("缺失文件时编辑 .gitignore 立即失效索引缓存", async () => {
  const fixture = await createFixture({
    ".gitignore": "dist/\n",
    "keep.ts": "export const keep = 1;\n",
    "secret.ts": "export const secret = 1;\n",
    "dist/bundle.js": "console.log('dist');\n",
  });
  const service = createFileService();
  try {
    const before = await listRelativePaths(service, fixture.rootPath);
    assert.ok(before.includes("secret.ts"));
    assert.ok(!before.includes("dist/bundle.js"));

    await rewriteRuleFile(join(fixture.rootPath, ".gitignore"), "dist/\nsecret.ts\n");

    // 同一个服务实例（60s TTL 内）：指纹跟随 .gitignore，必须重新扫描而不是命中旧索引。
    const after = await listRelativePaths(service, fixture.rootPath);
    assert.ok(!after.includes("secret.ts"), "编辑 .gitignore 后新规则必须立即生效");
    assert.ok(!after.includes("dist/bundle.js"));
    assert.equal(await fileExists(fixture.ignorePath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("显式 .zcodiumignore 覆盖 .gitignore，且编辑后缓存失效", async () => {
  const fixture = await createFixture({
    ".gitignore": "dist/\n",
    [ignoreFileName]: "# 自定义规则\n",
    "dist/bundle.js": "console.log('dist');\n",
    "secret.ts": "export const secret = 1;\n",
  });
  const service = createFileService();
  try {
    const before = await listRelativePaths(service, fixture.rootPath);
    assert.ok(
      before.includes("dist/bundle.js"),
      "已存在的 .zcodiumignore 是唯一权威规则源，.gitignore 不再参与",
    );
    assert.ok(before.includes("secret.ts"));

    await rewriteRuleFile(fixture.ignorePath, "# 自定义规则\ndist/\n");

    const after = await listRelativePaths(service, fixture.rootPath);
    assert.ok(!after.includes("dist/bundle.js"), "编辑 .zcodiumignore 后新规则必须立即生效");
    assert.ok(after.includes("secret.ts"), "未命中规则的文件不能被顺带排除");
    assert.ok(await fileExists(fixture.ignorePath), "编辑不能删除用户规则文件");
  } finally {
    await fixture.cleanup();
  }
});

test("只有设置页保存才创建 .zcodiumignore", async () => {
  const fixture = await createFixture({
    ".gitignore": "dist/\n",
    "dist/bundle.js": "console.log('dist');\n",
    "keep.ts": "export const keep = 1;\n",
  });
  const service = createFileService();
  try {
    assert.equal(await fileExists(fixture.ignorePath), false);
    const content = "# 自定义规则（不含 dist）\n";
    await service.writeWorkspaceFileSearchIgnore({ rootPath: fixture.rootPath, content });

    assert.equal(await fileExists(fixture.ignorePath), true, "保存必须创建文件");
    assert.equal(await readFile(fixture.ignorePath, "utf8"), content);
    const read = await service.readWorkspaceFileSearchIgnore({ rootPath: fixture.rootPath });
    assert.equal(read.source, "file");
    assert.equal(read.content, content);

    const listed = await listRelativePaths(service, fixture.rootPath);
    assert.ok(listed.includes("dist/bundle.js"), "保存后的规则是唯一真相源（.gitignore 不再生效）");
    assert.ok(listed.includes("keep.ts"));
  } finally {
    await fixture.cleanup();
  }
});

test("删除用户规则文件后回到内存默认规则，且不会被重新创建", async () => {
  const fixture = await createFixture({
    ".gitignore": "dist/\n",
    [ignoreFileName]: "# 自定义规则\n",
    "dist/bundle.js": "console.log('dist');\n",
    "keep.ts": "export const keep = 1;\n",
  });
  const service = createFileService();
  try {
    const before = await listRelativePaths(service, fixture.rootPath);
    assert.ok(before.includes("dist/bundle.js"), "自定义文件存在时 .gitignore 不参与");

    await rm(fixture.ignorePath);

    const after = await listRelativePaths(service, fixture.rootPath);
    assert.ok(!after.includes("dist/bundle.js"), "删除后回到 .gitignore + 内置默认的内存规则");
    assert.ok(after.includes("keep.ts"));
    const searched = await searchRelativePaths(service, fixture.rootPath, "keep");
    assert.ok(searched.includes("keep.ts"));
    assert.ok(!searched.includes("dist/bundle.js"));
    assert.equal(await fileExists(fixture.ignorePath), false, "list/search 不能重建被删除的文件");
  } finally {
    await fixture.cleanup();
  }
});

test("规则来源标记：缺失文件是内存合成，不是警告降级", async () => {
  const withGitignore = await createFixture({ ".gitignore": "dist/\n", "keep.ts": "" });
  const withoutGitignore = await createFixture({ "keep.ts": "" });
  try {
    const warnings: unknown[][] = [];
    const logger = {
      warn: (_traceId: unknown, ...args: unknown[]) => {
        warnings.push(args);
      },
    };

    const fromGitignore = await loadWorkspaceFileSearchIgnoreRules(withGitignore.rootPath, logger);
    assert.equal(fromGitignore.source, "memory-gitignore");
    assert.equal(isWorkspaceFileSearchPathIgnored(fromGitignore, "dist", "directory"), true);
    assert.equal(
      isWorkspaceFileSearchPathIgnored(fromGitignore, "node_modules", "directory"),
      true,
    );

    const fromTemplate = await loadWorkspaceFileSearchIgnoreRules(
      withoutGitignore.rootPath,
      logger,
    );
    assert.equal(fromTemplate.source, "memory-template");
    assert.equal(isWorkspaceFileSearchPathIgnored(fromTemplate, "node_modules", "directory"), true);

    assert.deepEqual(warnings, [], "缺失规则文件是正常状态，不能产生 warn 日志");
    assert.equal(await fileExists(withGitignore.ignorePath), false);
    assert.equal(await fileExists(withoutGitignore.ignorePath), false);
  } finally {
    await withGitignore.cleanup();
    await withoutGitignore.cleanup();
  }
});
