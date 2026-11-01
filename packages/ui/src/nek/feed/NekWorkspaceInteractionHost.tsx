import { NekInteractionHost } from "@/nek/interactions/NekInteractionHost.js";

/**
 * workspace 级交互卡：新建会话前的项目信任确认没有 sessionId，按 workspacePath 入队，
 * 由这个宿主渲染。它挂在 pane 的 feed provider 下面，回答走同一个 feed。
 */
export function NekWorkspaceInteractionHost({ workspacePath }: { workspacePath: string }) {
  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-4 empty:hidden">
      <NekInteractionHost sessionKey={workspacePath} workspacePath={workspacePath} />
    </div>
  );
}
