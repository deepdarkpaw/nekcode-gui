import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { CodeViewerWorkspaceScope } from "@/lib/codeViewerWorkspaceScope.js";
import { decodeFilePathUriEscapes, getPathLeaf, joinFilePath } from "@/lib/path.js";

/** Unscoped tool results belong to the pane that opened them, not necessarily the active host. */
export function withCodeViewerWorkspace(
  source: CodeViewerSource,
  scope: CodeViewerWorkspaceScope,
): CodeViewerSource {
  return source.workspacePath || source.workspaceIdentity || source.workspaceRemoteSessionId
    ? source
    : { ...source, ...scope };
}

export function normalizeCodeViewerSource(source: CodeViewerSource): CodeViewerSource {
  const decodedTitle = decodeFilePathUriEscapes(source.title);

  if (!("path" in source) || !source.path) {
    return decodedTitle === source.title ? source : { ...source, title: decodedTitle };
  }

  const decodedPath = decodeFilePathUriEscapes(source.path);
  const sourceLeaf = getPathLeaf(source.path);
  const decodedLeaf = getPathLeaf(decodedPath);
  const title =
    source.title === sourceLeaf || source.title.trim().length === 0 ? decodedLeaf : decodedTitle;

  // Inline text and diffs can have display-only paths. Disk reads need the workspace's path,
  // since the file service's process cwd is not the project's working directory.
  const path =
    source.workspacePath &&
    source.type !== "text" &&
    source.type !== "patch" &&
    source.type !== "multi-file-diff"
      ? joinFilePath(source.workspacePath, decodedPath)
      : decodedPath;

  if (path === source.path && title === source.title) {
    return source;
  }

  return {
    ...source,
    title,
    path,
  };
}
