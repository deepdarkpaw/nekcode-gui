/** Agent 预设、指令文件与约定的扩展目录。技能、模板只由 nek RPC 发现。 */
import type { INekConfigApi } from "@zcode/shared/nek-protocol";
import { readInstructionsDocument, writeInstructionsDocument } from "./instructionsDocument.js";
import { resourcePaths } from "./resourceFiles.js";
import {
  deleteAgentPreset,
  listAgentPresets,
  presetFileRevision,
  writeAgentPreset,
} from "./presetsDocument.js";
import type { NekConfigRuntime } from "./runtime.js";

export interface NekAgentGroup {
  listAgentPresets: INekConfigApi["listAgentPresets"];
  saveAgentPreset: INekConfigApi["saveAgentPreset"];
  deleteAgentPreset: INekConfigApi["deleteAgentPreset"];
  readInstructions: INekConfigApi["readInstructions"];
  writeInstructions: INekConfigApi["writeInstructions"];
  listExtensions: INekConfigApi["listExtensions"];
}

function stripExtension(name: string): string {
  return name.replace(/\.(md|ts|js|mjs|cjs)$/u, "");
}

export function createAgentGroup(runtime: NekConfigRuntime): NekAgentGroup {
  return {
    listAgentPresets: async (target, cwd) => {
      const context = runtime.target(target);
      let projectTrusted = true;
      if (cwd) {
        const control = await runtime.control(target);
        const trust = await control.call({ type: "get_project_trust", cwd });
        // v0.5.1: trust-manager.ts does not count `agents` as a trust-requiring resource,
        // although the RPC exposes it. An undecided project without gated resources is trusted.
        const needsTrust = trust.resources.some(({ kind }) => kind !== "agents");
        projectTrusted = trust.trusted ?? (!needsTrust || trust.defaultProjectTrust === "always");
      }
      return await listAgentPresets({
        executor: context.executor,
        agentDir: context.layout.agentDir,
        cwd,
        projectTrusted,
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
        cwd: options.cwd,
      });
      const written = [{ path: result.path, revision: result.revision }];
      if (result.removedPath) written.push({ path: result.removedPath, revision: "absent" });
      await runtime.publishWrite(target, written, {
        cwd: scope === "project" ? options.cwd : undefined,
      });
      return { revision: presetFileRevision(result.path, result.revision) };
    },

    deleteAgentPreset: async (target, scope, path, options) => {
      const context = runtime.target(target);
      const result = await deleteAgentPreset({
        executor: context.executor,
        agentDir: context.layout.agentDir,
        scope,
        path,
        expectedRevision: options.revision,
        cwd: options.cwd,
      });
      await runtime.publishWrite(target, [result], {
        cwd: scope === "project" ? options.cwd : undefined,
      });
      return { revision: result.revision };
    },

    readInstructions: async (target, scope, cwd) => {
      const { executor, layout } = runtime.target(target);
      return await readInstructionsDocument({
        executor,
        ...layout,
        scope,
        cwd,
        logger: runtime.logger,
        local: target.kind === "local",
      });
    },

    writeInstructions: async (target, scope, content, options) => {
      const { executor, layout } = runtime.target(target);
      const result = await writeInstructionsDocument({
        executor,
        ...layout,
        content,
        scope,
        cwd: options.cwd,
        expected: options,
        logger: runtime.logger,
      });
      await runtime.publishWrite(target, [result], {
        cwd: scope === "project" ? options.cwd : undefined,
      });
      return { revision: result.revision };
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
