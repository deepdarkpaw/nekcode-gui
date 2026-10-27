/**
 * 内存 mock 的基础设施：目标状态、模拟失败、watch/reload 事件、写盘包装。
 *
 * 与 `mockNekConfigApi.ts`（`INekConfigApi` 的方法实现）分开，既让单文件保持在 400 行以内，
 * 也让"怎么造事件"和"接口怎么实现"各自可读。
 */
import type {
  INekConfigApi,
  NekConfigError,
  NekConfigTarget,
  NekSessionReloadOutcome,
} from "@zcode/shared/nek-protocol";
import type { NekConfigChange } from "../NekSettingsContext.js";
import { MockLoginSimulator } from "./mockAuth.js";
import type { MockEventHub } from "./mockEvents.js";
import { clone, mockError, nextRevision, type MockFile, type MockMachine } from "./mockMachine.js";
import type * as models from "./mockModels.js";
import { createLocalMachine, createRemoteMachines } from "./mockSeed.js";

type MockFileKind = "settings" | "models" | "mcp" | "yaml" | "instructions";

export interface MockNekConfigApiOptions {
  /** 每次调用的模拟延迟（毫秒）；测试用 0。 */
  latencyMs?: number;
  deviceAutoCompleteMs?: number;
  loginStepMs?: number;
}

export function keyOf(target: NekConfigTarget): string {
  return target.kind === "local" ? "local" : `remote:${target.connectionId}`;
}

export abstract class MockNekConfigApiBase {
  readonly machines = new Map<string, MockMachine>();
  readonly login: MockLoginSimulator;
  protected readonly events: MockEventHub;
  private readonly failures = new Map<string, NekConfigError>();
  private readonly latencyMs: number;

  constructor(events: MockEventHub, options: MockNekConfigApiOptions) {
    this.events = events;
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

  /** 模拟某个预设文件被外部修改：改 revision 并发一条带 scope 的 watch 事件。 */
  simulatePresetEdit(target: NekConfigTarget, name: string): void {
    const machine = this.machineOf(target);
    const preset = machine.presets.find((entry) => entry.preset.name === name);
    if (!preset?.path) {
      throw mockError("validation", `unknown preset ${name}`);
    }
    preset.revision = nextRevision();
    const change: NekConfigChange = {
      file: preset.path,
      revision: preset.revision,
      scope: preset.source === "project" ? "project" : "global",
    };
    setTimeout(() => this.events.publish(keyOf(target), change), 0);
  }

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
    this.events.emitReload(keyOf(target), full);
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

  protected touchFor(target: NekConfigTarget): models.Touch {
    const agentDir = this.machineOf(target).agentDir;
    return (file) => {
      file.revision = nextRevision();
      const change: NekConfigChange = {
        file: file.path,
        revision: file.revision,
        // `~/.nek/agent/**` 是全局；`<cwd>/.nek/**`、`<cwd>/AGENTS.md` 是项目。
        scope: file.path.startsWith(`${agentDir}/`) ? "global" : "project",
      };
      setTimeout(() => this.events.publish(keyOf(target), change), 0);
      return file.revision;
    };
  }

  protected async call<T>(method: keyof INekConfigApi, run: () => T): Promise<T> {
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

  protected write(
    target: NekConfigTarget,
    method: keyof INekConfigApi,
    run: (machine: MockMachine, touch: models.Touch) => string,
  ) {
    return this.call(method, () => ({
      revision: run(this.machineOf(target), this.touchFor(target)),
    }));
  }
}
