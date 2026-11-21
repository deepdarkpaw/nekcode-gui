/** Agent 预设、指令文件与约定的扩展目录。技能、模板只由 nek RPC 发现。 */
import type {
  INekConfigApi,
  NekAgentPreset,
  NekAgentPresetsView,
  NekConfigRevision,
  NekConfigScope,
  NekConfigTarget,
} from "@zcode/shared/nek-protocol";
import { readTextDocument, writeTextDocument } from "./documents.js";
import { conflict } from "./errors.js";
import { instructionsPath } from "./paths.js";
import { resourcePaths } from "./resourceFiles.js";
import { deleteAgentPreset, listAgentPresets, writeAgentPreset } from "./presetsDocument.js";
import type { NekConfigRuntime } from "./runtime.js";

export interface NekAgentGroup {
  listAgentPresets: (target: NekConfigTarget, cwd?: string) => Promise<NekAgentPresetsView>;
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
  listExtensions: INekConfigApi["listExtensions"];
}

function stripExtension(name: string): string {
  return name.replace(/\.(md|ts|js|mjs|cjs)$/u, "");
}

export function createAgentGroup(runtime: NekConfigRuntime): NekAgentGroup {
  return {
    listAgentPresets: async (target, cwd) => {
      const context = runtime.target(target);
      return await listAgentPresets({
        executor: context.executor,
        agentDir: context.layout.agentDir,
        cwd,
        logger: runtime.logger,
      });
    },

    saveAgentPreset: async (target, scope, preset, options) => {
      const context = runtime.target(target);
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
      const path = instructionsPath(context.layout, scope, options.cwd);
      const document = await readTextDocument(context.executor, path);
      if (document.revision !== options.revision) throw conflict(path);
      const revision = await writeTextDocument(context.executor, path, content);
      runtime.publishWrite(target, [{ path, revision }]);
      return { revision };
    },

    listExtensions: async (target) => {
      const { executor, layout } = runtime.target(target);
      const paths = resourcePaths(layout.agentDir);
      const directory = paths.join(layout.agentDir, "extensions");
      const entries = await executor.listDir(directory);
      return {
        directory,
        extensions: entries
          .filter((entry) => !entry.isDirectory && /\.(ts|js|mjs|cjs)$/u.test(entry.name))
          .map((entry) => ({
            name: stripExtension(entry.name),
            path: paths.join(directory, entry.name),
          })),
      };
    },
  };
}
