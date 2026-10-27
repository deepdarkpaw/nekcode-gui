import type { ZCodeProvider } from "./zcode-task-types-core.js";
import { type ModelSelection } from "./model-selection.js";

export type AgentScope = "built-in" | "workspace" | "user";

export type AgentSource = "built-in" | "user";

export type BuiltInSubagentName = "general-purpose" | "Explore";

export type BuiltInSubagentModelSelectionOverrides = Partial<
  Record<BuiltInSubagentName, ModelSelection>
>;

export type AgentPermissionMode = "auto" | "plan";

export type AgentColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "orange"
  | "pink"
  | "cyan";

export type SubagentsListMode = "allRuntimeScopes" | "settingsUserOnly";

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  defaultModelSelection?: ModelSelection;
  modelSelectionOverride?: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
  path: string;
  scope: AgentScope;
  source: AgentSource;
  enabled: boolean;
  readOnly?: boolean;
  projectPath?: string;
  diagnostics?: AgentDiagnostic[];
}

export interface AgentDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AgentsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

export interface AgentsListResult {
  agents: AgentSummary[];
  userAgents: AgentSummary[];
  capability: AgentsCapability;
  diagnostics?: AgentDiagnostic[];
}

/** Agent 配置，用于创建/更新 agent */
export interface SubAgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
}

/** Agent 创建参数 */
export interface AgentCreateParams {
  config: SubAgentConfig;
  provider: ZCodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent 更新参数 */
export interface AgentUpdateParams {
  agentId: string;
  config: SubAgentConfig;
  oldFilePath?: string;
  provider: ZCodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent 删除参数 */
export interface AgentDeleteParams {
  agentId: string;
  filePath: string;
}

export interface BuiltInSubagentModelOverrideParams {
  agentName: BuiltInSubagentName;
  modelSelection?: ModelSelection;
}

export function createAgentStateId(input: {
  name: string;
  scope: AgentScope;
  source: AgentSource;
}): string {
  return `${input.source}:${input.scope}:${input.name.trim().toLowerCase()}`;
}
