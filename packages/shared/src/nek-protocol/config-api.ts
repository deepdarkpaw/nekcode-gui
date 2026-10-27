/**
 * 设置中心 API 契约（renderer ↔ host）。
 *
 * - renderer（`packages/ui/src/settings/nek/**`）只通过本接口读写 nek 配置；
 * - host / 远端 gui-server 的实现位于 `packages/services/src/nek-agent/`，底层是 nekConfigService
 *   （直接读写目标机器的 `~/.nek/agent/*`）与控制进程（`nek --mode rpc --control`）。
 * - 每个方法都带 `target`：本机或某个已连接的远程连接。配置写在 nek 所在的那台机器上。
 *
 * 并发：读取返回 `revision`；写入携带读取时的 `revision`，文件已被外部修改时以
 * `NekConfigConflictError`（`code: "conflict"`）拒绝，界面提示"配置已在外部修改"。
 */
import type {
  NekAgentPreset,
  NekAgentPresetEntry,
  NekConfigRevision,
  NekConfigScope,
  NekConfigTarget,
  NekConfigTargetInfo,
  NekCopyPreview,
  NekCopyResolution,
  NekCopySelection,
  NekLoginEvent,
  NekLoginSession,
  NekMcpConfigView,
  NekMcpImportPreview,
  NekModelConfig,
  NekModelsConfigView,
  NekProviderReferences,
  NekProviderRenamePreview,
  NekProviderWrite,
  NekSettingsPatch,
  NekSettingsReadResult,
  NekYamlPatch,
  NekYamlReadResult,
} from "./config-types.js";
import type {
  NekAuthProviderStatus,
  NekCatalogModel,
  NekConfigDiagnostic,
  NekFetchModelsResult,
  NekMcpTestResult,
  NekProjectTrust,
  NekProviderDraft,
  NekTestProviderResult,
  NekTestWebSearchResult,
} from "./gui-rpc.js";
import type {
  NekMcpExposure,
  NekMcpServerConfig,
  NekMcpServerStatus,
} from "./gui-extension-api.js";
export * from "./config-types.js";

// ============================================================================
// API
// ============================================================================

export interface INekConfigApi {
  // ---- 目标 ----
  listTargets(): Promise<NekConfigTargetInfo[]>;

  // ---- 服务商与模型 ----
  readModelsConfig(target: NekConfigTarget): Promise<NekModelsConfigView>;
  saveProvider(
    target: NekConfigTarget,
    provider: NekProviderWrite,
    options: { revision: string; isNew: boolean },
  ): Promise<NekConfigRevision>;
  deleteProvider(
    target: NekConfigTarget,
    providerId: string,
    options: { revision: string },
  ): Promise<NekConfigRevision>;
  getProviderReferences(
    target: NekConfigTarget,
    providerId: string,
  ): Promise<NekProviderReferences>;
  previewProviderRename(
    target: NekConfigTarget,
    from: string,
    to: string,
  ): Promise<NekProviderRenamePreview>;
  renameProvider(
    target: NekConfigTarget,
    from: string,
    to: string,
    options: { revision: string },
  ): Promise<NekConfigRevision>;
  saveModel(
    target: NekConfigTarget,
    providerId: string,
    model: NekModelConfig,
    options: { revision: string; previousId?: string },
  ): Promise<NekConfigRevision>;
  addModels(
    target: NekConfigTarget,
    providerId: string,
    models: NekModelConfig[],
    options: { revision: string },
  ): Promise<NekConfigRevision>;
  deleteModel(
    target: NekConfigTarget,
    providerId: string,
    modelId: string,
    options: { revision: string },
  ): Promise<NekConfigRevision>;
  reorderModels(
    target: NekConfigTarget,
    providerId: string,
    modelIds: string[],
    options: { revision: string },
  ): Promise<NekConfigRevision>;
  fetchProviderModels(
    target: NekConfigTarget,
    source: { providerId: string } | { draft: NekProviderDraft },
  ): Promise<NekFetchModelsResult>;
  testProvider(
    target: NekConfigTarget,
    source: { providerId: string } | { draft: NekProviderDraft },
    modelId: string,
  ): Promise<NekTestProviderResult>;
  getModelCatalog(target: NekConfigTarget, ids?: string[]): Promise<NekCatalogModel[]>;
  /** 当前目标上可用的模型（`provider/id`），用于默认模型、压缩模型、子代理模型选择。 */
  listAvailableModels(target: NekConfigTarget): Promise<NekCatalogModel[]>;

  // ---- settings.json ----
  readSettings(
    target: NekConfigTarget,
    scope: NekConfigScope,
    cwd?: string,
  ): Promise<NekSettingsReadResult>;
  patchSettings(
    target: NekConfigTarget,
    scope: NekConfigScope,
    patch: NekSettingsPatch,
    options: { revision: string; cwd?: string },
  ): Promise<NekConfigRevision>;
  testWebSearch(target: NekConfigTarget, query: string): Promise<NekTestWebSearchResult>;

  // ---- 账号登录 ----
  getAuthStatus(target: NekConfigTarget): Promise<NekAuthProviderStatus[]>;
  /** 开始登录；进度经 `onLoginEvent` 推送。 */
  startLogin(target: NekConfigTarget, provider: string): Promise<NekLoginSession>;
  answerLoginPrompt(loginId: string, promptId: string, value: string): Promise<void>;
  cancelLogin(loginId: string): Promise<void>;
  onLoginEvent(loginId: string, listener: (event: NekLoginEvent) => void): () => void;
  logout(target: NekConfigTarget, provider: string): Promise<void>;

  // ---- MCP ----
  readMcpConfig(
    target: NekConfigTarget,
    scope: NekConfigScope,
    cwd?: string,
  ): Promise<NekMcpConfigView>;
  saveMcpServer(
    target: NekConfigTarget,
    scope: NekConfigScope,
    entry: { name: string; config: NekMcpServerConfig; previousName?: string },
    options: { revision: string; cwd?: string },
  ): Promise<NekConfigRevision>;
  setMcpServerOverride(
    target: NekConfigTarget,
    name: string,
    override: {
      enabled?: boolean;
      exposure?: NekMcpExposure;
      toolExposure?: Record<string, NekMcpExposure>;
    },
    options: { revision: string; scope: NekConfigScope; cwd?: string },
  ): Promise<NekConfigRevision>;
  deleteMcpServer(
    target: NekConfigTarget,
    scope: NekConfigScope,
    name: string,
    options: { revision: string; cwd?: string },
  ): Promise<NekConfigRevision>;
  previewMcpImport(
    target: NekConfigTarget,
    scope: NekConfigScope,
    json: string,
    cwd?: string,
  ): Promise<NekMcpImportPreview>;
  testMcpServer(
    target: NekConfigTarget,
    source: { name: string; cwd?: string } | { config: NekMcpServerConfig },
  ): Promise<NekMcpTestResult>;
  /** 来自当前目标上运行中的会话进程；没有会话进程时返回 undefined。 */
  getMcpStatus(target: NekConfigTarget, cwd?: string): Promise<NekMcpServerStatus[] | undefined>;
  mcpServerAction(
    target: NekConfigTarget,
    name: string,
    action: "reconnect" | "login" | "logout",
    cwd?: string,
  ): Promise<NekMcpServerStatus>;

  // ---- nek.yaml、子代理预设、指令 ----
  readNekYaml(
    target: NekConfigTarget,
    scope: NekConfigScope,
    cwd?: string,
  ): Promise<NekYamlReadResult>;
  patchNekYaml(
    target: NekConfigTarget,
    scope: NekConfigScope,
    patch: NekYamlPatch,
    options: { revision: string; cwd?: string },
  ): Promise<NekConfigRevision>;
  listAgentPresets(target: NekConfigTarget, cwd?: string): Promise<NekAgentPresetEntry[]>;
  saveAgentPreset(
    target: NekConfigTarget,
    scope: NekConfigScope,
    preset: NekAgentPreset,
    options: { revision: string; previousName?: string; cwd?: string },
  ): Promise<NekConfigRevision>;
  deleteAgentPreset(
    target: NekConfigTarget,
    scope: NekConfigScope,
    name: string,
    options: { revision: string; cwd?: string },
  ): Promise<NekConfigRevision>;
  readInstructions(
    target: NekConfigTarget,
    scope: NekConfigScope,
    cwd?: string,
  ): Promise<NekConfigRevision & { path: string; content: string }>;
  writeInstructions(
    target: NekConfigTarget,
    scope: NekConfigScope,
    content: string,
    options: { revision: string; cwd?: string },
  ): Promise<NekConfigRevision>;
  listResources(
    target: NekConfigTarget,
    cwd?: string,
  ): Promise<{
    skills: Array<{ name: string; path: string; description?: string }>;
    prompts: Array<{ name: string; path: string; description?: string }>;
    extensions: Array<{ name: string; path: string }>;
    directories: { agentDir: string; projectDir?: string };
  }>;

  // ---- 项目信任 ----
  getProjectTrust(target: NekConfigTarget, cwd: string): Promise<NekProjectTrust>;
  setProjectTrust(target: NekConfigTarget, cwd: string, trusted: boolean): Promise<void>;

  // ---- 校验与重载 ----
  validate(target: NekConfigTarget, cwd?: string): Promise<NekConfigDiagnostic[]>;
  /** 写入后由实现自动调用；也供"重新载入"按钮使用。返回仍需等待本轮结束的会话数。 */
  reloadRunningSessions(
    target: NekConfigTarget,
  ): Promise<{ reloaded: number; deferred: number; diagnostics: NekConfigDiagnostic[] }>;

  // ---- 外部修改 ----
  /** 监视目标机器的配置文件（本机 fs.watch，远程每 5 s stat），变化时回调。 */
  watch(
    target: NekConfigTarget,
    listener: (change: { file: string; revision: string }) => void,
  ): () => void;

  // ---- 复制到远程 ----
  previewCopy(
    from: NekConfigTarget,
    to: NekConfigTarget,
    selection: NekCopySelection,
  ): Promise<NekCopyPreview>;
  copy(
    from: NekConfigTarget,
    to: NekConfigTarget,
    selection: NekCopySelection,
    resolution: NekCopyResolution,
  ): Promise<void>;
}
