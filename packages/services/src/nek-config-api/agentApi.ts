/**
 * Agent 相关：子代理预设、指令文件（AGENTS.md）、资源清单（skills / prompts / extensions）。
 *
 * 预设与指令都要 revision 校验：它们是纯文本，用户在编辑器里也可能同时改。
 * 资源清单只读，扫描失败只影响该目录（不打断列表）。
 */
import type {
  NekAgentPreset,
  NekAgentPresetEntry,
  NekConfigRevision,
  NekConfigScope,
  NekConfigTarget,
} from "@zcode/shared/nek-protocol";
import { join } from "node:path";
import { parseFrontmatterDocument } from "../nek-agent/config/nekConfigDocuments.js";
import { readTextDocument, writeTextDocument } from "./documents.js";
import { conflict } from "./errors.js";
import { instructionsPath, projectConfigDir, resourceDirs } from "./paths.js";
import { deleteAgentPreset, listAgentPresets, writeAgentPreset } from "./presetsDocument.js";
import type { NekConfigRuntime } from "./runtime.js";

export interface NekAgentResource {
  name: string;
  path: string;
  description?: string;
}

export interface NekResourcesResult {
  skills: NekAgentResource[];
  prompts: NekAgentResource[];
  extensions: Array<{ name: string; path: string }>;
  directories: { agentDir: string; projectDir?: string };
}

export interface NekAgentGroup {
  listAgentPresets: (target: NekConfigTarget, cwd?: string) => Promise<NekAgentPresetEntry[]>;
  saveAgentPreset: (
    target: NekConfigTarget,
    scope: NekConfigScope,
    preset: NekAgentPreset,
    options: { revision: string; previousName?: string; cwd?: string },
  ) => Promise<NekConfigRevision>;
  deleteAgentPreset: (
    target: NekConfigTarget,
    scope: NekConfigScope,
    name: string,
    options: { revision: string; cwd?: string },
  ) => Promise<NekConfigRevision>;
  readInstructions: (
    target: NekConfigTarget,
    scope: NekConfigScope,
    cwd?: string,
  ) => Promise<NekConfigRevision & { path: string; content: string }>;
  writeInstructions: (
    target: NekConfigTarget,
    scope: NekConfigScope,
    content: string,
    options: { revision: string; cwd?: string },
  ) => Promise<NekConfigRevision>;
  listResources: (target: NekConfigTarget, cwd?: string) => Promise<NekResourcesResult>;
}

/** 从文件头部提取 `description`（缺 frontmatter 或没有该字段时返回 undefined）。 */
async function descriptionOf(
  readFile: (path: string) => Promise<string | null>,
  path: string,
): Promise<string | undefined> {
  const content = await readFile(path);
  if (content === null || !content.startsWith("---")) return undefined;
  try {
    const parsed = parseFrontmatterDocument(path, content);
    const description = parsed.frontmatter.description;
    return typeof description === "string" ? description : undefined;
  } catch {
    return undefined;
  }
}

function stripExtension(name: string): string {
  return name.replace(/\.(md|ts|js|mjs|cjs)$/u, "");
}

export function createAgentGroup(runtime: NekConfigRuntime): NekAgentGroup {
  return {
    listAgentPresets: async (target, cwd) => {
      const context = runtime.target(target);
      runtime.rememberCwd(target, cwd);
      return await listAgentPresets({
        executor: context.executor,
        agentDir: context.layout.agentDir,
        cwd,
        logger: runtime.logger,
      });
    },

    saveAgentPreset: async (target, scope, preset, options) => {
      const context = runtime.target(target);
      runtime.rememberCwd(target, options.cwd);
      const result = await writeAgentPreset({
        executor: context.executor,
        agentDir: context.layout.agentDir,
        scope,
        preset,
        expectedRevision: options.revision,
        previousName: options.previousName,
        cwd: options.cwd,
      });
      const written = [{ path: result.path, revision: result.revision }];
      if (result.removedPath) written.push({ path: result.removedPath, revision: "absent" });
      runtime.publishWrite(target, written);
      return { revision: result.revision };
    },

    deleteAgentPreset: async (target, scope, name, options) => {
      const context = runtime.target(target);
      runtime.rememberCwd(target, options.cwd);
      const result = await deleteAgentPreset({
        executor: context.executor,
        agentDir: context.layout.agentDir,
        scope,
        name,
        expectedRevision: options.revision,
        cwd: options.cwd,
      });
      runtime.publishWrite(target, [result]);
      return { revision: result.revision };
    },

    readInstructions: async (target, scope, cwd) => {
      const context = runtime.target(target);
      runtime.rememberCwd(target, cwd);
      const path = instructionsPath(context.layout, scope, cwd);
      const document = await readTextDocument(context.executor, path);
      return {
        path,
        revision: document.revision,
        content: document.content ?? "",
      };
    },

    writeInstructions: async (target, scope, content, options) => {
      const context = runtime.target(target);
      runtime.rememberCwd(target, options.cwd);
      const path = instructionsPath(context.layout, scope, options.cwd);
      const document = await readTextDocument(context.executor, path);
      if (document.revision !== options.revision) throw conflict(path);
      const revision = await writeTextDocument(context.executor, path, content);
      runtime.publishWrite(target, [{ path, revision }]);
      return { revision };
    },

    listResources: async (target, cwd) => {
      const context = runtime.target(target);
      const agentDir = context.layout.agentDir;
      const skills = new Map<string, NekAgentResource>();
      const prompts = new Map<string, NekAgentResource>();
      const extensions = new Map<string, { name: string; path: string }>();
      for (const dir of resourceDirs(context.layout, "skills", cwd)) {
        for (const entry of await context.executor.listDir(dir)) {
          if (!entry.isDirectory) continue;
          const path = join(dir, entry.name, "SKILL.md");
          const description = await descriptionOf((file) => context.executor.readFile(file), path);
          skills.set(entry.name, { name: entry.name, path, ...(description ? { description } : {}) });
        }
      }
      for (const dir of resourceDirs(context.layout, "prompts", cwd)) {
        for (const entry of await context.executor.listDir(dir)) {
          if (entry.isDirectory || !entry.name.endsWith(".md")) continue;
          const path = join(dir, entry.name);
          const description = await descriptionOf((file) => context.executor.readFile(file), path);
          prompts.set(stripExtension(entry.name), {
            name: stripExtension(entry.name),
            path,
            ...(description ? { description } : {}),
          });
        }
      }
      for (const dir of resourceDirs(context.layout, "extensions", cwd)) {
        for (const entry of await context.executor.listDir(dir)) {
          if (entry.isDirectory || !/\.(ts|js|mjs|cjs)$/u.test(entry.name)) continue;
          extensions.set(stripExtension(entry.name), {
            name: stripExtension(entry.name),
            path: join(dir, entry.name),
          });
        }
      }
      return {
        skills: [...skills.values()],
        prompts: [...prompts.values()],
        extensions: [...extensions.values()],
        directories: {
          agentDir,
          ...(cwd ? { projectDir: projectConfigDir(cwd) } : {}),
        },
      };
    },
  };
}
