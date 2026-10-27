/**
 * `INekConfigApi` 的内存 mock，用于开发与测试（不访问文件系统、不调用模型 API）。
 *
 * - 每个目标一份状态（`mockSeed.ts`）；未连接的远程目标上任何调用都抛 `not_connected`；
 * - 写入校验 revision，不一致抛 `conflict`；每次写入后异步触发 watch 事件；
 * - 状态、事件与写盘包装在 `mockNekConfigApiBase.ts`；这里只实现 `INekConfigApi` 的方法。
 */
import type {
  INekConfigApi,
  NekConfigTarget,
  NekMcpServerConfig,
  NekSettingsPatch,
} from "@zcode/shared/nek-protocol";
import { MockEventHub } from "./mockEvents.js";
import {
  keyOf,
  MockNekConfigApiBase,
  type MockNekConfigApiOptions,
} from "./mockNekConfigApiBase.js";
import { mockError } from "./mockMachine.js";
import * as mcp from "./mockMcp.js";
import * as models from "./mockModels.js";
import { MOCK_BUILTIN_TOOLS } from "./mockSeed.js";
import * as settings from "./mockSettings.js";

export type { MockNekConfigApiOptions } from "./mockNekConfigApiBase.js";

export class MockNekConfigApi extends MockNekConfigApiBase implements INekConfigApi {
  private readonly copyFailures = new Map<string, string>();

  constructor(options: MockNekConfigApiOptions = {}) {
    super(new MockEventHub(), options);
  }

  // ---- 目标 ----

  listTargets = () =>
    this.call("listTargets", () => [...this.machines.values()].map((machine) => machine.info));

  // ---- 服务商与模型 ----

  readModelsConfig = (target: NekConfigTarget, _cwd?: string) =>
    this.call("readModelsConfig", () => {
      const machine = this.machineOf(target);
      return {
        path: machine.models.path,
        revision: machine.models.revision,
        providers: machine.models.value.map(models.providerView),
        diagnostics: [],
      };
    });

  saveProvider: INekConfigApi["saveProvider"] = (target, provider, options) =>
    this.write(target, "saveProvider", (machine, touch) =>
      models.saveProvider(machine, provider, options, touch),
    );

  deleteProvider: INekConfigApi["deleteProvider"] = (target, providerId, options) =>
    this.write(target, "deleteProvider", (machine, touch) => {
      models.findProvider(machine, providerId);
      if (machine.models.revision !== options.revision) {
        throw mockError("conflict", `${machine.models.path} was modified externally`);
      }
      machine.models.value = machine.models.value.filter((provider) => provider.id !== providerId);
      return touch(machine.models);
    });

  getProviderReferences: INekConfigApi["getProviderReferences"] = (target, providerId, _cwd) =>
    this.call("getProviderReferences", () => models.references(this.machineOf(target), providerId));

  previewProviderRename: INekConfigApi["previewProviderRename"] = (target, from, to, _cwd) =>
    this.call("previewProviderRename", () => ({
      from,
      to,
      references: models.references(this.machineOf(target), from),
    }));

  renameProvider: INekConfigApi["renameProvider"] = (target, from, to, options) =>
    this.write(target, "renameProvider", (machine, touch) =>
      models.renameProvider(machine, from, to, options.revision, touch),
    );

  saveModel: INekConfigApi["saveModel"] = (target, providerId, model, options) =>
    this.write(target, "saveModel", (machine, touch) =>
      models.updateModels(
        machine,
        providerId,
        options.revision,
        (list) => models.saveModel(list, model, options.previousId),
        touch,
      ),
    );

  addModels: INekConfigApi["addModels"] = (target, providerId, added, options) =>
    this.write(target, "addModels", (machine, touch) =>
      models.updateModels(
        machine,
        providerId,
        options.revision,
        (list) => models.addModels(list, added),
        touch,
      ),
    );

  deleteModel: INekConfigApi["deleteModel"] = (target, providerId, modelId, options) =>
    this.write(target, "deleteModel", (machine, touch) =>
      models.updateModels(
        machine,
        providerId,
        options.revision,
        (list) => list.filter((model) => model.id !== modelId),
        touch,
      ),
    );

  reorderModels: INekConfigApi["reorderModels"] = (target, providerId, modelIds, options) =>
    this.write(target, "reorderModels", (machine, touch) =>
      models.updateModels(
        machine,
        providerId,
        options.revision,
        (list) => models.reorderModels(list, modelIds),
        touch,
      ),
    );

  fetchProviderModels: INekConfigApi["fetchProviderModels"] = (target, source) =>
    this.call("fetchProviderModels", () => models.fetchModels(this.machineOf(target), source));

  testProvider: INekConfigApi["testProvider"] = (target, source, modelId) =>
    this.call("testProvider", () => models.testProvider(this.machineOf(target), source, modelId));

  getModelCatalog: INekConfigApi["getModelCatalog"] = (target, ids) =>
    this.call("getModelCatalog", () => {
      this.machineOf(target);
      return models.catalog(ids);
    });

  listAvailableModels: INekConfigApi["listAvailableModels"] = (target) =>
    this.call("listAvailableModels", () => models.availableModels(this.machineOf(target)));

  listBuiltinTools: INekConfigApi["listBuiltinTools"] = (target) =>
    this.call("listBuiltinTools", () => {
      this.machineOf(target);
      return MOCK_BUILTIN_TOOLS.map((tool) => ({ ...tool }));
    });

  // ---- settings.json ----

  readSettings: INekConfigApi["readSettings"] = (target, scope, cwd) =>
    this.call("readSettings", () => settings.readSettings(this.machineOf(target), scope, cwd));

  patchSettings: INekConfigApi["patchSettings"] = (
    target,
    scope,
    patch: NekSettingsPatch,
    options,
  ) =>
    this.write(target, "patchSettings", (machine, touch) =>
      settings.patchSettings(machine, scope, patch, options, touch),
    );

  testWebSearch: INekConfigApi["testWebSearch"] = (target, query) =>
    this.call("testWebSearch", () => {
      const machine = this.machineOf(target);
      const key = machine.settings.value.webSearch?.apiKey ?? "";
      return key.includes("bad")
        ? { ok: false as const, message: "401 Unauthorized: invalid Exa API key" }
        : { ok: true as const, latencyMs: 640, resultCount: query.length > 0 ? 5 : 0 };
    });

  // ---- 账号登录 ----

  getAuthStatus: INekConfigApi["getAuthStatus"] = (target) =>
    this.call("getAuthStatus", () => [...this.machineOf(target).auth.values()]);

  startLogin: INekConfigApi["startLogin"] = (target, provider) =>
    this.call("startLogin", () => this.login.start(this.machineOf(target), target, provider));

  answerLoginPrompt: INekConfigApi["answerLoginPrompt"] = (loginId, promptId, value) =>
    this.call("answerLoginPrompt", () => this.login.answer(loginId, promptId, value));

  cancelLogin: INekConfigApi["cancelLogin"] = (loginId) =>
    this.call("cancelLogin", () => this.login.cancel(loginId));

  onLoginEvent: INekConfigApi["onLoginEvent"] = (loginId, listener) =>
    this.login.subscribe(loginId, listener);

  logout: INekConfigApi["logout"] = (target, provider) =>
    this.call("logout", () => {
      const machine = this.machineOf(target);
      const status = machine.auth.get(provider);
      if (status) {
        machine.auth.set(provider, {
          ...status,
          kind: "none",
          state: "ok",
          expiresAt: undefined,
        });
      }
    });

  // ---- MCP ----

  readMcpConfig: INekConfigApi["readMcpConfig"] = (target, scope, cwd) =>
    this.call("readMcpConfig", () => mcp.readMcp(this.machineOf(target), scope, cwd));

  saveMcpServer: INekConfigApi["saveMcpServer"] = (target, scope, entry, options) =>
    this.write(target, "saveMcpServer", (machine, touch) =>
      mcp.saveServer(machine, scope, entry, options, touch),
    );

  setMcpServerOverride: INekConfigApi["setMcpServerOverride"] = (target, name, override, options) =>
    this.write(target, "setMcpServerOverride", (machine, touch) =>
      mcp.setOverride(machine, name, override as Partial<NekMcpServerConfig>, options, touch),
    );

  deleteMcpServer: INekConfigApi["deleteMcpServer"] = (target, scope, name, options) =>
    this.write(target, "deleteMcpServer", (machine, touch) =>
      mcp.deleteServer(machine, scope, name, options, touch),
    );

  previewMcpImport: INekConfigApi["previewMcpImport"] = (target, _scope, json) =>
    this.call("previewMcpImport", () => mcp.previewImport(this.machineOf(target), json));

  testMcpServer: INekConfigApi["testMcpServer"] = (target, source) =>
    this.call("testMcpServer", () => {
      this.machineOf(target);
      return mcp.testServer(source);
    });

  getMcpStatus: INekConfigApi["getMcpStatus"] = (target, cwd) =>
    this.call("getMcpStatus", () => mcp.mcpStatus(this.machineOf(target), cwd));

  mcpServerAction: INekConfigApi["mcpServerAction"] = (target, name, action) =>
    this.call("mcpServerAction", () => {
      const machine = this.machineOf(target);
      const config = machine.mcp.value[name];
      if (!config) {
        throw mockError("validation", `Unknown MCP server ${name}`);
      }
      if (action !== "reconnect") {
        machine.mcpAuth.set(name, action === "login");
      }
      return mcp.statusOf(machine, name, config);
    });

  // ---- nek.yaml、子代理预设、指令 ----

  readNekYaml: INekConfigApi["readNekYaml"] = (target, scope, cwd) =>
    this.call("readNekYaml", () => settings.readYaml(this.machineOf(target), scope, cwd));

  patchNekYaml: INekConfigApi["patchNekYaml"] = (target, scope, patch, options) =>
    this.write(target, "patchNekYaml", (machine, touch) =>
      settings.patchYaml(machine, scope, patch, options, touch),
    );

  listAgentPresets: INekConfigApi["listAgentPresets"] = (target, cwd) =>
    this.call("listAgentPresets", () => settings.listPresets(this.machineOf(target), cwd));

  saveAgentPreset: INekConfigApi["saveAgentPreset"] = (target, scope, preset, options) =>
    this.write(target, "saveAgentPreset", (machine, touch) =>
      settings.savePreset(machine, scope, preset, options, touch),
    );

  deleteAgentPreset: INekConfigApi["deleteAgentPreset"] = (target, scope, name, options) =>
    this.write(target, "deleteAgentPreset", (machine, touch) =>
      settings.deletePreset(machine, scope, name, options, touch),
    );

  readInstructions: INekConfigApi["readInstructions"] = (target, scope, cwd) =>
    this.call("readInstructions", () => {
      const file = settings.instructionsFile(this.machineOf(target), scope, cwd);
      return { path: file.path, revision: file.revision, content: file.value };
    });

  writeInstructions: INekConfigApi["writeInstructions"] = (target, scope, content, options) =>
    this.write(target, "writeInstructions", (machine, touch) => {
      const file = settings.instructionsFile(machine, scope, options.cwd);
      if (file.revision !== options.revision) {
        throw mockError("conflict", `${file.path} was modified externally`);
      }
      file.value = content;
      return touch(file);
    });

  listResources: INekConfigApi["listResources"] = (target, cwd) =>
    this.call("listResources", () => settings.resources(this.machineOf(target), cwd));

  // ---- 项目信任 ----

  getProjectTrust: INekConfigApi["getProjectTrust"] = (target, cwd) =>
    this.call("getProjectTrust", () => settings.projectTrust(this.machineOf(target), cwd));

  setProjectTrust: INekConfigApi["setProjectTrust"] = (target, cwd, trusted) =>
    this.call("setProjectTrust", () => {
      this.machineOf(target).trust.set(cwd, trusted);
    });

  // ---- 校验与重载 ----

  validate: INekConfigApi["validate"] = (target) =>
    this.call("validate", () => {
      this.machineOf(target);
      return [];
    });

  reloadRunningSessions: INekConfigApi["reloadRunningSessions"] = (target) =>
    this.call("reloadRunningSessions", () => {
      this.machineOf(target);
      return { reloaded: 1, deferred: 1, diagnostics: [], failures: [] };
    });

  onReloadResult: INekConfigApi["onReloadResult"] = (target, listener) =>
    this.events.onReload(keyOf(target), listener);

  // ---- 外部修改 ----

  watch: INekConfigApi["watch"] = (target, listener) => this.events.watch(keyOf(target), listener);

  // ---- 复制到远程 ----

  previewCopy: INekConfigApi["previewCopy"] = (from, to, selection) =>
    this.call("previewCopy", () =>
      settings.previewCopy(this.machineOf(from), this.machineOf(to), selection),
    );

  copy: INekConfigApi["copy"] = (from, to, selection, resolution) =>
    this.call("copy", () => {
      const failures = new Map(this.copyFailures);
      this.copyFailures.clear();
      return settings.copy(
        this.machineOf(from),
        this.machineOf(to),
        selection,
        resolution,
        this.touchFor(to),
        (key) => failures.get(key),
      );
    });

  /** 让下一次 `copy` 的指定项以 `status:"failed"` 返回（键是 `<kind>:<id>`）。 */
  failCopyItem(key: string, message: string): void {
    this.copyFailures.set(key, message);
  }
}
