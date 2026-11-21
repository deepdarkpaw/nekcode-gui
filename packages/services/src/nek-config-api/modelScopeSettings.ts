import type { INekConfigApi } from "@zcode/shared/nek-protocol";
import { conflict, validationError } from "./errors.js";
import { settingsPath } from "./paths.js";
import type { NekConfigRuntime, NekTargetContext } from "./runtime.js";
import {
  patchSettingsDocument,
  readSettingsDocument,
  type NekSettingsDocument,
} from "./settingsDocument.js";

interface ModelScopeDocuments {
  global: NekSettingsDocument;
  project?: NekSettingsDocument;
}

/** 项目文件只有在 nek 信任该工作区时才能成为范围的写入目标。 */
export async function readModelScopeDocuments(
  runtime: NekConfigRuntime,
  context: NekTargetContext,
  cwd?: string,
  knownGlobal?: NekSettingsDocument,
): Promise<ModelScopeDocuments> {
  const { executor, layout, target } = context;
  const global =
    knownGlobal ?? (await readSettingsDocument(executor, settingsPath(layout, "global")));
  cwd = cwd?.trim();
  if (!cwd) return { global };
  const path = settingsPath(layout, "project", cwd);
  if (!(await executor.stat(path))) return { global };
  const control = await runtime.control(target);
  const { trusted } = await control.call({ type: "get_project_trust", cwd });
  // 显式决定由 nek 提供；默认策略取刚读的全局文件，不用控制进程启动时的设置副本。
  if (!(trusted ?? global.raw.defaultProjectTrust === "always")) return { global };
  return { global, project: await readSettingsDocument(executor, path) };
}

function effectiveScopeDocument({ global, project }: ModelScopeDocuments): NekSettingsDocument {
  return project?.raw.enabledModels === undefined ? global : project;
}

export function modelScopePatterns(document: NekSettingsDocument): string[] {
  const patterns = document.raw.enabledModels;
  if (patterns === undefined) return [];
  assertPatterns(patterns);
  return patterns;
}

function assertPatterns(patterns: unknown): asserts patterns is string[] {
  if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string")) {
    throw validationError("enabledModels must be an array of strings", {
      enabledModels: "invalid",
    });
  }
}

export function sameModelScopePatterns(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((pattern, index) => pattern === right[index]);
}

export function createSaveModelScope(runtime: NekConfigRuntime): INekConfigApi["saveModelScope"] {
  return async (target, patterns, { cwd, expectedPatterns }) => {
    assertPatterns(patterns);
    assertPatterns(expectedPatterns);
    const context = runtime.target(target);
    const document = effectiveScopeDocument(await readModelScopeDocuments(runtime, context, cwd));
    const current = modelScopePatterns(document);
    if (!sameModelScopePatterns(current, expectedPatterns)) throw conflict(document.path);
    if (sameModelScopePatterns(current, patterns)) return { revision: document.revision };
    const result = await patchSettingsDocument({
      executor: context.executor,
      path: document.path,
      expectedRevision: document.revision,
      // 项目里的 [] 必须保留，删除键会重新继承全局范围。
      patch: { enabledModels: patterns },
    });
    runtime.publishWrite(target, [result]);
    return { revision: result.revision };
  };
}
