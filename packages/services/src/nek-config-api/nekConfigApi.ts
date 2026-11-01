/**
 * `NekConfigApi`：设置中心契约（`INekConfigApi`）的真实实现。
 *
 * 结构：一个运行时（目标解析、控制进程、监视、重载、登录）+ 若干功能分组。
 * 这里只做方法到分组的委托，保证每一组都能单独读、单独测。
 *
 * 依赖注入点（`NekConfigApiOptions`）：
 * - `hosts`：目标表与执行器（本机用 `createLocalNekConfigTargetHost`，远程由 host 注入 SSH）；
 * - `sessions`：会话进程登记表（MCP 状态与 reload 需要）；
 * - `control`：控制进程工厂（测试注入假实现）；
 * - `forwardLoginPorts`：远程 OAuth 回调端口转发（host 侧 SSH）；
 * - `config`：`remote.configPollSeconds`、watch 防抖、是否写后自动重载。
 */
import type { INekConfigApi } from "@zcode/shared/nek-protocol";
import { createAgentGroup } from "./agentApi.js";
import type { NekAgentGroup } from "./agentApi.js";
import { createControlGroup } from "./controlApi.js";
import type { NekControlGroup } from "./controlApi.js";
import { createCopyGroup } from "./copyApi.js";
import type { NekCopyGroup } from "./copyApi.js";
import { createMcpGroup } from "./mcpApi.js";
import type { NekMcpGroup } from "./mcpApi.js";
import { createModelsGroup } from "./modelsApi.js";
import type { NekModelsGroup } from "./modelsApi.js";
import { NekConfigRuntime } from "./runtime.js";
import type { NekConfigApiOptions } from "./runtime.js";
import { createSettingsGroup } from "./settingsApi.js";
import type { NekSettingsGroup } from "./settingsApi.js";
import { createYamlGroup } from "./yamlApi.js";
import type { NekYamlGroup } from "./yamlApi.js";

export class NekConfigApi implements INekConfigApi {
  private readonly options: NekConfigApiOptions;
  private readonly runtime: NekConfigRuntime;
  private readonly models: NekModelsGroup;
  private readonly settings: NekSettingsGroup;
  private readonly mcp: NekMcpGroup;
  private readonly yaml: NekYamlGroup;
  private readonly agent: NekAgentGroup;
  private readonly control: NekControlGroup;
  private readonly copyGroup: NekCopyGroup;

  constructor(options: NekConfigApiOptions) {
    this.options = options;
    this.runtime = new NekConfigRuntime(options);
    this.models = createModelsGroup(this.runtime);
    this.settings = createSettingsGroup(this.runtime);
    this.mcp = createMcpGroup(this.runtime);
    this.yaml = createYamlGroup(this.runtime);
    this.agent = createAgentGroup(this.runtime);
    this.control = createControlGroup(this.runtime);
    this.copyGroup = createCopyGroup(this.runtime);
  }

  // ---- 目标 ----

  listTargets: INekConfigApi["listTargets"] = async () => await this.options.hosts.listTargets();

  // ---- 服务商与模型 ----

  readModelsConfig: INekConfigApi["readModelsConfig"] = (...args) =>
    this.models.readModelsConfig(...args);
  saveProvider: INekConfigApi["saveProvider"] = (...args) => this.models.saveProvider(...args);
  deleteProvider: INekConfigApi["deleteProvider"] = (...args) =>
    this.models.deleteProvider(...args);
  getProviderReferences: INekConfigApi["getProviderReferences"] = (...args) =>
    this.models.getProviderReferences(...args);
  previewProviderRename: INekConfigApi["previewProviderRename"] = (...args) =>
    this.models.previewProviderRename(...args);
  renameProvider: INekConfigApi["renameProvider"] = (...args) =>
    this.models.renameProvider(...args);
  saveModel: INekConfigApi["saveModel"] = (...args) => this.models.saveModel(...args);
  addModels: INekConfigApi["addModels"] = (...args) => this.models.addModels(...args);
  deleteModel: INekConfigApi["deleteModel"] = (...args) => this.models.deleteModel(...args);
  reorderModels: INekConfigApi["reorderModels"] = (...args) => this.models.reorderModels(...args);
  fetchProviderModels: INekConfigApi["fetchProviderModels"] = (...args) =>
    this.control.fetchProviderModels(...args);
  testProvider: INekConfigApi["testProvider"] = (...args) => this.control.testProvider(...args);
  getModelCatalog: INekConfigApi["getModelCatalog"] = (...args) =>
    this.control.getModelCatalog(...args);
  listAvailableModels: INekConfigApi["listAvailableModels"] = (...args) =>
    this.control.listAvailableModels(...args);
  listBuiltinTools: INekConfigApi["listBuiltinTools"] = (...args) =>
    this.control.listBuiltinTools(...args);

  // ---- settings.json ----

  readSettings: INekConfigApi["readSettings"] = (...args) => this.settings.readSettings(...args);
  patchSettings: INekConfigApi["patchSettings"] = (...args) => this.settings.patchSettings(...args);
  testWebSearch: INekConfigApi["testWebSearch"] = (...args) => this.control.testWebSearch(...args);

  // ---- 账号登录 ----

  getAuthStatus: INekConfigApi["getAuthStatus"] = (...args) => this.control.getAuthStatus(...args);
  startLogin: INekConfigApi["startLogin"] = (...args) => this.control.startLogin(...args);
  answerLoginPrompt: INekConfigApi["answerLoginPrompt"] = (...args) =>
    this.control.answerLoginPrompt(...args);
  cancelLogin: INekConfigApi["cancelLogin"] = (...args) => this.control.cancelLogin(...args);
  onLoginEvent: INekConfigApi["onLoginEvent"] = (...args) => this.control.onLoginEvent(...args);
  logout: INekConfigApi["logout"] = (...args) => this.control.logout(...args);

  // ---- MCP ----

  readMcpConfig: INekConfigApi["readMcpConfig"] = (...args) => this.mcp.readMcpConfig(...args);
  saveMcpServer: INekConfigApi["saveMcpServer"] = (...args) => this.mcp.saveMcpServer(...args);
  setMcpServerOverride: INekConfigApi["setMcpServerOverride"] = (...args) =>
    this.mcp.setMcpServerOverride(...args);
  deleteMcpServer: INekConfigApi["deleteMcpServer"] = (...args) =>
    this.mcp.deleteMcpServer(...args);
  previewMcpImport: INekConfigApi["previewMcpImport"] = (...args) =>
    this.mcp.previewMcpImport(...args);
  testMcpServer: INekConfigApi["testMcpServer"] = (...args) => this.mcp.testMcpServer(...args);
  getMcpStatus: INekConfigApi["getMcpStatus"] = (...args) => this.mcp.getMcpStatus(...args);
  mcpServerAction: INekConfigApi["mcpServerAction"] = (...args) =>
    this.mcp.mcpServerAction(...args);

  // ---- nek.yaml、子代理预设、指令 ----

  readNekYaml: INekConfigApi["readNekYaml"] = (...args) => this.yaml.readNekYaml(...args);
  patchNekYaml: INekConfigApi["patchNekYaml"] = (...args) => this.yaml.patchNekYaml(...args);
  listAgentPresets: INekConfigApi["listAgentPresets"] = (...args) =>
    this.agent.listAgentPresets(...args);
  saveAgentPreset: INekConfigApi["saveAgentPreset"] = (...args) =>
    this.agent.saveAgentPreset(...args);
  deleteAgentPreset: INekConfigApi["deleteAgentPreset"] = (...args) =>
    this.agent.deleteAgentPreset(...args);
  readInstructions: INekConfigApi["readInstructions"] = (...args) =>
    this.agent.readInstructions(...args);
  writeInstructions: INekConfigApi["writeInstructions"] = (...args) =>
    this.agent.writeInstructions(...args);
  listResources: INekConfigApi["listResources"] = (...args) => this.agent.listResources(...args);

  // ---- 项目信任 ----

  getProjectTrust: INekConfigApi["getProjectTrust"] = (...args) =>
    this.control.getProjectTrust(...args);
  setProjectTrust: INekConfigApi["setProjectTrust"] = (...args) =>
    this.control.setProjectTrust(...args);

  // ---- 校验与重载 ----

  validate: INekConfigApi["validate"] = (...args) => this.control.validate(...args);
  reloadRunningSessions: INekConfigApi["reloadRunningSessions"] = async (target, cwd) =>
    await this.runtime.reload(target, cwd);
  onReloadResult: INekConfigApi["onReloadResult"] = (target, listener) =>
    this.runtime.onReloadResult(target, listener);

  // ---- 外部修改 ----

  watch: INekConfigApi["watch"] = (target, listener, cwd) =>
    this.runtime.watch(target, listener, cwd);

  // ---- 复制到远程 ----

  previewCopy: INekConfigApi["previewCopy"] = (...args) => this.copyGroup.previewCopy(...args);
  copy: INekConfigApi["copy"] = (...args) => this.copyGroup.copy(...args);

  /** 释放监视器与所有控制进程（宿主退出时调用）。 */
  dispose(): void {
    this.runtime.dispose();
  }
}
