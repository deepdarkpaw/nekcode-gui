import { describe, expect, it } from "vitest";
import type { CodeViewerSource } from "./codeViewer.js";
import { withCodeViewerWorkspace } from "./codeViewerSource.js";
import { getActiveSidePaneTab, openCodeViewerSidePane } from "./workspaceSidePane.js";

const readResult = {
  type: "file",
  title: "repack_images.go",
  path: "internal/workflow/repack_images.go",
} as const;
const shell = { workspacePath: "G:/projects/game" };
const remotePane = {
  workspacePath: "/srv/game",
  workspaceIdentity: "ssh:game",
  workspaceRemoteSessionId: "session-1",
};

function openPreview(source: CodeViewerSource, shellScope = shell) {
  const tab = getActiveSidePaneTab(
    openCodeViewerSidePane(null, withCodeViewerWorkspace(source, shellScope)),
  );
  if (tab?.type !== "code-viewer") throw new Error("Expected a code viewer");
  return tab.source;
}

describe("side pane file reads", () => {
  it("resolves the tool's project-relative path before handing it to the viewer", () => {
    expect(openPreview(readResult)).toMatchObject({
      title: readResult.title,
      path: "G:/projects/game/internal/workflow/repack_images.go",
    });
  });

  it("uses the originating split pane's directory and file service, not the shell's", () => {
    expect(openPreview(withCodeViewerWorkspace(readResult, remotePane))).toMatchObject({
      ...remotePane,
      path: "/srv/game/internal/workflow/repack_images.go",
    });
  });

  it("keeps an explicitly local source local even when opened from a remote pane", () => {
    const source = { ...readResult, workspacePath: shell.workspacePath };
    expect(openPreview(source, remotePane)).toEqual({
      ...source,
      path: "G:/projects/game/internal/workflow/repack_images.go",
    });
  });

  it.each(["/opt/external.go", "D:\\external\\file.go", "\\\\server\\share\\file.go"])(
    "does not prefix an absolute path: %s",
    (path) => expect(openPreview({ ...readResult, path }).path).toBe(path),
  );

  it("does not turn an inline diff label into a disk path", () => {
    const patch = { ...readResult, type: "patch", patch: "@@ -1 +1 @@\n-a\n+b" } as const;
    expect(openPreview(patch).path).toBe(readResult.path);
  });
});
