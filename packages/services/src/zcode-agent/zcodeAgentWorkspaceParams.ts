import type { ZCodeAgentMcpServer, ZCodeMcpListMode } from "@zcode/shared";

export interface ZCodeAgentWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 远程 workspace 的运行时会话身份；只用于隔离/路由，不能替代 workspacePath。 */
  remoteSessionId?: string;
}

export interface ZCodeAgentListMcpServerStatusesParams extends ZCodeAgentWorkspaceTarget {
  mcpServers?: ZCodeAgentMcpServer[];
  mode?: ZCodeMcpListMode;
}

// Composer Skill catalog：以 sessionId 区分 workspace 当前目录和
// resident Session runtime 快照；不参与 Settings 管理目录。
export interface ZCodeAgentSkillReferenceCatalogParams extends ZCodeAgentWorkspaceTarget {
  sessionId?: string;
}
