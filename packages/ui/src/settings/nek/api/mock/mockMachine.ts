/**
 * 内存 mock 的"机器"状态：每个配置目标一份 `~/.nek/agent`，文件带 revision。
 */
import type {
  NekAgentPreset,
  NekAuthProviderStatus,
  NekConfigDiagnostic,
  NekConfigError,
  NekConfigErrorCode,
  NekConfigTargetInfo,
  NekMcpServerConfig,
  NekProviderConfig,
  NekSettingsView,
  NekYamlReadResult,
} from "@zcode/shared/nek-protocol";

export interface MockFile<T> {
  path: string;
  revision: string;
  value: T;
}

export interface MockPreset {
  source: "builtin" | "user" | "project";
  path?: string;
  revision: string;
  preset: NekAgentPreset;
}

export type MockYamlValues = NekYamlReadResult["values"];

export interface MockMachine {
  info: NekConfigTargetInfo;
  agentDir: string;
  models: MockFile<NekProviderConfig[]>;
  settings: MockFile<NekSettingsView>;
  projectSettings: Map<string, MockFile<NekSettingsView>>;
  mcp: MockFile<Record<string, NekMcpServerConfig>>;
  projectMcp: Map<string, MockFile<Record<string, Partial<NekMcpServerConfig>>>>;
  yaml: MockFile<MockYamlValues>;
  projectYaml: Map<string, MockFile<MockYamlValues>>;
  presets: MockPreset[];
  /** 坏掉的预设文件（列表照常返回，问题在页面上显示）。 */
  brokenPresets: NekConfigDiagnostic[];
  instructions: MockFile<string>;
  projectInstructions: Map<string, MockFile<string>>;
  auth: Map<string, NekAuthProviderStatus>;
  trust: Map<string, boolean | null>;
  mcpAuth: Map<string, boolean>;
}

let revisionSeq = 0;

export function nextRevision(): string {
  revisionSeq += 1;
  return `rev-${revisionSeq}`;
}

export function mockFile<T>(path: string, value: T, exists = true): MockFile<T> {
  return { path, revision: exists ? nextRevision() : "absent", value };
}

/** 跨 RPC 的错误形状（普通对象，不是 Error 实例）。 */
export function mockError(
  code: NekConfigErrorCode,
  message: string,
  fieldErrors?: Record<string, string>,
): NekConfigError {
  return fieldErrors ? { code, message, fieldErrors } : { code, message };
}

export function assertRevision(file: MockFile<unknown>, revision: string): void {
  if (file.revision !== revision) {
    throw mockError("conflict", `${file.path} was modified externally`);
  }
}

export function projectFile<T>(
  map: Map<string, MockFile<T>>,
  cwd: string | undefined,
  pathOf: (cwd: string) => string,
  empty: () => T,
): MockFile<T> {
  if (!cwd) {
    throw mockError("validation", "Project scope requires cwd");
  }
  let file = map.get(cwd);
  if (!file) {
    file = mockFile(pathOf(cwd), empty(), false);
    map.set(cwd, file);
  }
  return file;
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
