/**
 * `INekConfigApi` 的内存 mock，用于开发与测试（不访问文件系统、不调用模型 API）。
 *
 * - 每个目标一份状态（`mockSeed.ts`）；未连接的远程目标上任何调用都抛 `not_connected`；
 * - 写入校验 revision，不一致抛 `conflict`；每次写入后异步触发 watch 事件；
 * - `simulateExternalEdit` 模拟终端里的 nek 或手工编辑修改了文件；
 * - `failNext` 让下一次调用某方法失败（测试回滚）。
 */
import type {
  INekConfigApi,
  NekConfigError,
  NekConfigTarget,
  NekMcpServerConfig,
  NekSessionReloadOutcome,
  NekSettingsPatch,
} from "@zcode/shared/nek-protocol";
import type { NekConfigChange } from "../NekSettingsContext.js";
import { MockLoginSimulator } from "./mockAuth.js";
import { clone, mockError, nextRevision, type MockFile, type MockMachine } from "./mockMachine.js";
import * as mcp from "./mockMcp.js";
import * as models from "./mockModels.js";
import { createLocalMachine, createRemoteMachines, MOCK_BUILTIN_TOOLS } from "./mockSeed.js";
import * as settings from "./mockSettings.js";

type WatchListener = (change: NekConfigChange) => void;
type MockFileKind = "settings" | "models" | "mcp" | "yaml" | "instructions";

export interface MockNekConfigApiOptions {
  /** 每次调用的模拟延迟（毫秒）；测试用 0。 */
  latencyMs?: number;
  deviceAutoCompleteMs?: number;
  loginStepMs?: number;
}

function keyOf(target: NekConfigTarget): string {
  return target.kind === "local" ? "local" : `remote:${target.connectionId}`;
}

export class MockNekConfigApi implements INekConfigApi {
  readonly machines = new Map<string, MockMachine>();
  readonly login: MockLoginSimulator;
  private readonly watchers = new Map<string, Set<WatchListener>>();
  private readonly reloadListeners = new Map<string, Set<(result: NekSessionReloadOutcome) => void>>();
  private readonly failures = new Map<string, NekConfigError>();
  private readonly latencyMs: number;

  constructor(options: MockNekConfigApiOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.login = new MockLoginSimulator({
      deviceAutoCompleteMs: options.deviceAutoCompleteMs ?? 8000,
      stepMs: options.loginStepMs ?? 300,
    });
    for (const machine of [createLocalMachine(), ...createRemoteMachines()]) {
      this.machines.set(keyOf(machine.info.target), machine);
    }
  }

  // ---- mock 控制 ----

  failNext(method: keyof INekConfigApi, error: NekConfigError): void {
    this.failures.set(method, error);
  }

  setConnected(target: NekConfigTarget, connected: boolean): void {
    const machine = this.machines.get(keyOf(target));
    if (machine) {
      machine.info = {
        ...machine.info,
        connected,
        nek: connected
          ? { state: "ready", version: "0.4.0", agentDir: machine.agentDir }
          : { state: "unknown" },
      };
    }
  }

  /** 模拟外部修改：改动文件内容并触发 watch。 */
  simulateExternalEdit(
    target: NekConfigTarget,
    kind: MockFileKind,
    mutate?: (value: never) => unknown,
  ): string {
    const machine = this.machineOf(target);
    const file = this.fileOfKind(machine, kind);
    if (mutate) {
      file.value = mutate(file.value as never);
    }
    return this.touchFor(target)(file);
  }

  machineOf(target: NekConfigTarget): MockMachine {
    const machine = this.machines.get(keyOf(target));
    if (!machine) {
      throw mockError("not_connected", `Unknown target ${keyOf(target)}`);
    }
    if (!machine.info.connected) {
      throw mockError("not_connected", `${machine.info.label} is not connected`);
    }
    return machine;
  }

  private fileOfKind(machine: MockMachine, kind: MockFileKind): MockFile<unknown> {
    const files: Record<MockFileKind, MockFile<unknown>> = {
      settings: machine.settings,
      models: machine.models,
      mcp: machine.mcp,
      yaml: machine.yaml,
      instructions: machine.instructions,
    };
    return files[kind];
  }

  private touchFor(target: NekConfigTarget): models.Touch {
    const agentDir = this.machineOf(target).agentDir;
    return (file) => {
      file.revision = nextRevision();
      const change: NekConfigChange = {
        file: file.path,
        revision: file.revision,
        // `~/.nek/agent/**` 是全局；`<cwd>/.nek/**`、`<cwd>/AGENTS.md` 是项目。
        scope: file.path.startsWith(`${agentDir}/`) ? "global" : "project",
      };
      setTimeout(() => {
        for (const listener of this.watchers.get(keyOf(target)) ?? []) {
          listener(change);
        }
      }, 0);
      return file.revision;
    };
  }

  private async call<T>(method: keyof INekConfigApi, run: () => T): Promise<T> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    const failure = this.failures.get(method);
    if (failure) {
      this.failures.delete(method);
      throw failure;
    }
    return clone(run());
  }

  private write(
    target: NekConfigTarget,
    method: keyof INekConfigApi,
    run: (machine: MockMachine, touch: models.Touch) => string,
  ) {
    return this.call(method, () => ({
      revision: run(this.machineOf(target), this.touchFor(target)),
    }));
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

  onReloadResult: INekConfigApi["onReloadResult"] = (target, listener) => {
    const key = keyOf(target);
    const set = this.reloadListeners.get(key) ?? new Set();
    set.add(listener);
    this.reloadListeners.set(key, set);
    return () => {
      set.delete(listener);
    };
  };

  /** 模拟写盘后的自动 reload 结果（含进程级失败）。 */
  simulateReloadResult(
    target: NekConfigTarget,
    result: Pick<NekSessionReloadOutcome, "failures"> &
      Partial<Omit<NekSessionReloadOutcome, "failures">>,
  ): void {
    const full: NekSessionReloadOutcome = {
      reloaded: result.reloaded ?? 1,
      deferred: result.deferred ?? 0,
      diagnostics: result.diagnostics ?? [],
      failures: result.failures,
    };
    for (const listener of this.reloadListeners.get(keyOf(target)) ?? []) {
      listener(full);
    }
  }

  // ---- 外部修改 ----

  watch: INekConfigApi["watch"] = (target, listener) => {
    const key = keyOf(target);
    const set = this.watchers.get(key) ?? new Set<WatchListener>();
    set.add(listener);
    this.watchers.set(key, set);
    return () => {
      set.delete(listener);
    };
  };

  // ---- 复制到远程 ----

  previewCopy: INekConfigApi["previewCopy"] = (from, to, selection) =>
    this.call("previewCopy", () =>
      settings.previewCopy(this.machineOf(from), this.machineOf(to), selection),
    );

  copy: INekConfigApi["copy"] = (from, to, selection, resolution) =>
    this.call("copy", () =>
      settings.copy(
        this.machineOf(from),
        this.machineOf(to),
        selection,
        resolution,
        this.touchFor(to),
      ),
    );
}
