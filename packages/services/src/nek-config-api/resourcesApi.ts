import type {
  INekResourceConfigApi,
  NekConfigTarget,
  NekListResourcesResult,
  NekResourceCatalog,
  NekResourceFileRef,
  NekResourceInfo,
  NekResourceQuery,
} from "@zcode/shared/nek-protocol";
import { serializeFrontmatterDocument } from "../nek-agent/config/nekConfigDocuments.js";
import { conflict, validationError } from "./errors.js";
import {
  assertResourceQuery,
  checkResourceFile,
  readResourceDocument,
  resourcePaths,
  resourceRelativePath,
  resourceRoots,
  validateResourceMarkdown,
} from "./resourceFiles.js";
import type { NekConfigRuntime, NekTargetContext } from "./runtime.js";

const MAX_RESOURCES = 4_096;
const RESOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu;

async function list(
  runtime: NekConfigRuntime,
  target: NekConfigTarget,
  query: NekResourceQuery,
): Promise<NekResourceCatalog> {
  assertResourceQuery(query);
  const context = runtime.target(target);
  const control = await runtime.control(target);
  const { resourceType, cwd } = query;
  const result: NekListResourcesResult = await control.call<"list_resources">({
    type: "list_resources",
    resourceType,
    ...(cwd ? { cwd } : {}),
  });
  if (
    !Array.isArray(result?.resources) ||
    !Array.isArray(result.diagnostics) ||
    typeof result.projectTrusted !== "boolean"
  ) {
    throw new Error("Invalid list_resources response from nek");
  }
  if (result.resources.length > MAX_RESOURCES || result.diagnostics.length > MAX_RESOURCES) {
    throw new Error(`nek resource catalog exceeds the ${MAX_RESOURCES} entry limit`);
  }
  return { ...result, roots: resourceRoots(context.layout.agentDir, query) };
}

function requireTrustedProject(cwd: string | undefined, trusted: boolean): string {
  if (!cwd || !trusted) throw validationError("Project resources require a trusted workspace");
  return cwd;
}

/** CLI 决定条目身份；写入范围还须匹配目标机上的真实配置根。 */
async function managedFile(
  runtime: NekConfigRuntime,
  context: NekTargetContext,
  input: NekResourceFileRef,
): Promise<{ entry: NekResourceInfo; cwd?: string }> {
  const catalog = await list(runtime, context.target, input);
  const entry = catalog.resources.find(
    (item) => item.path === input.path && item.resourceType === input.resourceType,
  );
  if (!entry || entry.scope === "temporary")
    throw validationError(`Resource is not managed here: ${input.path}`);
  const project = entry.scope === "project";
  const cwd = project ? requireTrustedProject(input.cwd, catalog.projectTrusted) : undefined;
  const root = project ? catalog.roots.project : catalog.roots.global;
  const relative = root && resourceRelativePath(root, entry.path);
  if (!relative || !entry.path.endsWith(".md"))
    throw validationError(`Resource is outside its configuration directory: ${entry.path}`);
  await checkResourceFile(context.executor, cwd ?? context.layout.agentDir, entry.path, false);
  return { entry, cwd };
}

function checkTarget(runtime: NekConfigRuntime, context: NekTargetContext): void {
  if (runtime.target(context.target).executor !== context.executor) {
    throw new Error("nek configuration connection changed; retry on the current target");
  }
}

export function createResourcesGroup(runtime: NekConfigRuntime): INekResourceConfigApi {
  return {
    listConfigResources: (target, query) => list(runtime, target, query),
    async setResourceEnabled(target, { resourceType, cwd, path, enabled }) {
      assertResourceQuery({ resourceType, cwd });
      if (
        typeof path !== "string" ||
        !resourcePaths(path).isAbsolute(path) ||
        typeof enabled !== "boolean"
      ) {
        throw validationError("Expected an absolute resource path and a boolean enabled state");
      }
      const context = runtime.target(target);
      const control = await runtime.control(target);
      checkTarget(runtime, context);
      const result = await control.call<"set_resource_enabled">({
        type: "set_resource_enabled",
        resourceType,
        path,
        enabled,
        ...(cwd ? { cwd } : {}),
      });
      if (
        (result?.settingsScope !== "project" && result?.settingsScope !== "global") ||
        typeof result.enabled !== "boolean"
      ) {
        throw new Error("Invalid set_resource_enabled response from nek");
      }
      checkTarget(runtime, context);
      const project =
        result.settingsScope === "project" ? requireTrustedProject(cwd, true) : undefined;
      const anchor = project ?? context.layout.agentDir;
      const paths = resourcePaths(anchor);
      const settings = project
        ? paths.join(project, ".nek", "settings.json")
        : paths.join(anchor, "settings.json");
      runtime.publishWrite(target, [{ path: settings, revision: "resource-settings" }], {
        cwd: project,
      });
      return result;
    },
    async createResource(target, input) {
      const { resourceType, name, description, content, scope } = input;
      if (scope !== "global" && scope !== "project")
        throw validationError("Invalid resource scope");
      if (
        typeof name !== "string" ||
        name.length > 64 ||
        !RESOURCE_NAME.test(name) ||
        WINDOWS_DEVICE_NAME.test(name)
      ) {
        throw validationError(
          "Use up to 64 lowercase letters, digits, and single hyphens for the resource name",
        );
      }
      if (
        typeof content !== "string" ||
        (description !== undefined &&
          (typeof description !== "string" || description.length > 1_024)) ||
        (resourceType === "skills" && !description?.trim())
      ) {
        throw validationError("A skill needs a description of up to 1024 characters");
      }
      const context = runtime.target(target);
      const catalog = await list(runtime, target, input);
      const cwd =
        scope === "project" ? requireTrustedProject(input.cwd, catalog.projectTrusted) : undefined;
      const root = (scope === "project" ? catalog.roots.project : catalog.roots.global)!;
      const paths = resourcePaths(root);
      const path =
        resourceType === "skills"
          ? paths.join(root, name, "SKILL.md")
          : paths.join(root, `${name}.md`);
      const metadata = {
        ...(resourceType === "skills" ? { name } : {}),
        ...(description?.trim() ? { description: description.trim() } : {}),
      };
      const markdown = Object.keys(metadata).length
        ? serializeFrontmatterDocument(metadata, content)
        : content;
      validateResourceMarkdown(path, markdown);
      await checkResourceFile(context.executor, cwd ?? context.layout.agentDir, path, true);
      checkTarget(runtime, context);
      await context.executor.writeResourceFile(path, markdown, true);
      runtime.publishWrite(target, [{ path, revision: "resource-created" }], { cwd });
    },
    async readPromptTemplate(target, input) {
      if (input.resourceType !== "prompts") throw validationError("Expected a prompt template");
      const context = runtime.target(target);
      const { entry } = await managedFile(runtime, context, input);
      checkTarget(runtime, context);
      return readResourceDocument(context.executor, entry.path);
    },
    async writePromptTemplate(target, input) {
      if (input.resourceType !== "prompts") throw validationError("Expected a prompt template");
      const context = runtime.target(target);
      const { entry, cwd } = await managedFile(runtime, context, input);
      validateResourceMarkdown(entry.path, input.content);
      const current = await readResourceDocument(context.executor, entry.path);
      if (current.revision !== input.revision) throw conflict(entry.path);
      if (current.content === input.content) return;
      checkTarget(runtime, context);
      await context.executor.writeResourceFile(entry.path, input.content, false);
      runtime.publishWrite(target, [{ path: entry.path, revision: "resource-edited" }], { cwd });
    },
    async deleteResource(target, input) {
      const context = runtime.target(target);
      const { entry, cwd } = await managedFile(runtime, context, input);
      checkTarget(runtime, context);
      // 仅删除入口文件，不连带删除技能目录里用户的脚本和资源。
      await context.executor.remove(entry.path);
      runtime.publishWrite(target, [{ path: entry.path, revision: "absent" }], { cwd });
    },
  };
}
