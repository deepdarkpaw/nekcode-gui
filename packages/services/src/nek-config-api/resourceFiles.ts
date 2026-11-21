import { posix, win32 } from "node:path";
import { MAX_NEK_RESOURCE_FILE_BYTES, type NekResourceQuery } from "@zcode/shared/nek-protocol";
import { parseFrontmatterDocument, stripBom } from "../nek-agent/config/nekConfigDocuments.js";
import { validationError } from "./errors.js";
import type { NekConfigHostExecutor } from "./hostExecutor.js";
import { PROJECT_CONFIG_DIR_NAME } from "./paths.js";
import { encodeRevision } from "./revision.js";

export function resourcePaths(anchor: string) {
  return /^[A-Za-z]:|^\\/u.test(anchor) ? win32 : posix;
}

export function assertResourceQuery(query: NekResourceQuery): void {
  if (query.resourceType !== "skills" && query.resourceType !== "prompts") {
    throw validationError("Unknown nek resource type");
  }
  if (query.cwd !== undefined && !resourcePaths(query.cwd).isAbsolute(query.cwd)) {
    throw validationError("Resource project requires an absolute workspace path");
  }
}

export function resourceRoots(agentDir: string, { resourceType, cwd }: NekResourceQuery) {
  return {
    global: resourcePaths(agentDir).join(agentDir, resourceType),
    ...(cwd
      ? { project: resourcePaths(cwd).join(cwd, PROJECT_CONFIG_DIR_NAME, resourceType) }
      : {}),
  };
}

export function resourceRelativePath(root: string, file: string): string[] | undefined {
  const paths = resourcePaths(root);
  if (!paths.isAbsolute(file) || paths.normalize(file) !== file) return;
  const relative = paths.relative(root, file);
  const parts = relative.split(paths.sep);
  if (
    !relative ||
    paths.isAbsolute(relative) ||
    parts.some((part) => !part || part === ".." || /[:\\]/u.test(part) || part.includes("\0"))
  )
    return;
  return parts;
}

/** 允许用户显式选定 agentDir/cwd；其下的配置根和每级资源目录都不得是软链。 */
export async function checkResourceFile(
  executor: NekConfigHostExecutor,
  anchor: string,
  file: string,
  create: boolean,
): Promise<void> {
  const paths = resourcePaths(anchor);
  const parts = resourceRelativePath(anchor, file);
  if (!parts || parts.length > 64) throw validationError(`Invalid resource path: ${file}`);
  let parent = anchor;
  for (const part of parts.slice(0, -1)) {
    parent = paths.join(parent, part);
    const kind = await executor.resourceEntryKind(parent);
    if (kind === null && create) return;
    if (kind !== "directory") throw validationError(`Not a regular resource directory: ${parent}`);
  }
  const kind = await executor.resourceEntryKind(file);
  if (create ? kind !== null : kind !== "file") {
    throw validationError(
      create ? `Resource already exists: ${file}` : `Not a regular resource file: ${file}`,
    );
  }
}

export function validateResourceMarkdown(path: string, content: string): void {
  if (typeof content !== "string" || Buffer.byteLength(content) > MAX_NEK_RESOURCE_FILE_BYTES) {
    throw validationError(`Resource exceeds ${MAX_NEK_RESOURCE_FILE_BYTES / 1024} KB: ${path}`);
  }
  const text = stripBom(content).replace(/\r\n?/gu, "\n");
  const body =
    text.startsWith("---") && text.indexOf("\n---", 3) >= 0
      ? parseFrontmatterDocument(path, text).body
      : text;
  if (!body.trim()) throw validationError("Resource Markdown body is required");
}

export async function readResourceDocument(executor: NekConfigHostExecutor, path: string) {
  const content = await executor.readResourceFile(path, MAX_NEK_RESOURCE_FILE_BYTES);
  const info = await executor.stat(path);
  if (!info) throw validationError(`Missing resource: ${path}`);
  return { content, revision: encodeRevision(info, content) };
}
