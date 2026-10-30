/**
 * nek 会话绑定表：renderer 的 `sessionId` ↔ 服务内部会话键。
 *
 * 绑定在 create/resume 时写入，命令与状态动作都靠它定位记录；表有硬上限，
 * 超出说明调用方在泄漏会话，必须报错而不是悄悄扩容。
 */
import { sessionMapKey } from "./frameHelpers.js";
import type { NekSessionBinding, NekWorkspaceTarget } from "./types.js";
import type { NekSessionResult } from "../service/types.js";

const MAX_BINDINGS = 5_000;

export class NekSessionBindings {
  private readonly entries = new Map<string, NekSessionBinding>();

  get size(): number {
    return this.entries.size;
  }

  bind(target: NekWorkspaceTarget, result: NekSessionResult): void {
    if (this.entries.size >= MAX_BINDINGS)
      throw new Error(`nek session binding limit exceeded (${MAX_BINDINGS})`);
    this.entries.set(sessionMapKey(target, result.sessionId), {
      target,
      sessionKey: result.sessionKey,
      sessionId: result.sessionId,
      ...(result.sessionPath ? { sessionPath: result.sessionPath } : {}),
    });
  }

  /** 先按 workspace 精确键命中；同一会话换 workspaceIdentity 时按 sessionId 兜底匹配。 */
  require(target: NekWorkspaceTarget, sessionId: string): NekSessionBinding {
    const direct = this.entries.get(sessionMapKey(target, sessionId));
    if (direct) return direct;
    const binding = [...this.entries.values()].find(
      (candidate) =>
        candidate.target.workspacePath === target.workspacePath &&
        candidate.sessionId === sessionId,
    );
    if (!binding)
      throw new Error(`nek session ${sessionId} is not open in ${target.workspacePath}`);
    return binding;
  }

  resolve(target: NekWorkspaceTarget, sessionId?: string): string | undefined {
    if (sessionId) return this.entries.get(sessionMapKey(target, sessionId))?.sessionKey;
    const candidate = [...this.entries.values()].find(
      (binding) => binding.target.workspacePath === target.workspacePath,
    );
    return candidate?.sessionKey;
  }

  remove(target: NekWorkspaceTarget, sessionId: string): void {
    this.entries.delete(sessionMapKey(target, sessionId));
  }

  clear(): void {
    this.entries.clear();
  }
}
