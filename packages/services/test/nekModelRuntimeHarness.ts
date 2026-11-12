import { basename, join, resolve } from "node:path";
import type {
  NekConfigDiagnostic,
  NekModel,
  NekRpcCommand,
  NekReloadResult,
  NekSessionSnapshot,
} from "@zcode/shared/nek-protocol";
import { createNekRuntimeServices } from "../src/createNekRuntimeServices.js";
import {
  createMemoryNekConfigHostExecutor,
  type MemoryNekConfigHostExecutor,
  type NekControlClient,
} from "../src/nek-config-api/index.js";
import { createProcess, guiInfo } from "./nekSessionHarness.js";

export const LOCAL = { kind: "local" as const };
export const agentDir = resolve(".tmp/model-runtime/agent");
export const modelsPath = join(agentDir, "models.json");
export const modelsText = (id = "old", baseUrl = "http://old", api = "openai-completions") =>
  JSON.stringify({ providers: { CPA: { api, baseUrl, apiKey: "test", models: [{ id }] } } });

/** Real production composition, adapter, service, pool and JSONL. Only filesystem/CLI are ports. */
export function runtimeHarness(shared?: MemoryNekConfigHostExecutor) {
  const executor =
    shared ??
    createMemoryNekConfigHostExecutor({ agentDir, files: { [modelsPath]: modelsText() } });
  const readModels = (): NekModel[] => {
    const provider = JSON.parse(executor.files.get(modelsPath) ?? '{"providers":{}}').providers.CPA;
    return (provider?.models ?? []).map((model: { id: string }) => ({
      ...model,
      provider: "CPA",
      name: model.id,
      api: provider.api,
      baseUrl: provider.baseUrl,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
  };
  let reloadError: string | undefined;
  let diagnostics: NekConfigDiagnostic[] = [];
  let hold: (() => Promise<void>) | undefined;
  const sessions: Array<
    ReturnType<typeof createProcess> & {
      busy: boolean;
      selected(): NekModel | undefined;
      snapshot(): NekModel[];
    }
  > = [];
  const snapshots = new Map<string, NekSessionSnapshot>();
  let controlModels = readModels();
  let controlFailure: string | undefined;
  const control = createProcess((command) => {
    if (command.type === "read_session_snapshot") return snapshots.get(command.sessionPath);
    if (command.type === "get_project_trust") return { cwd: "", trusted: true, resources: [] };
    if (command.type === "get_available_models") return { models: controlModels };
    if (command.type === "get_model_catalog")
      return { models: controlModels.map((model) => ({ ...model, thinkingLevels: [] })) };
    if (command.type === "auth_status") return { providers: [] };
    if (command.type === "reload") {
      if (controlFailure) throw new Error(controlFailure);
      controlModels = readModels();
      return { deferred: false, diagnostics: [] };
    }
    if (command.type === "list_sessions") return { sessions: [] };
    return {};
  });
  const configControl: NekControlClient = {
    call: (command) => control.process.client.call(command),
    onAuthEvent: () => () => undefined,
    respondExtensionUi: () => undefined,
    setStructuredHandler: () => undefined,
    close: async () => {
      await control.process.dispose();
    },
  };
  const runtime = createNekRuntimeServices({
    config: {
      hosts: { executor: () => executor, listTargets: async () => [] },
      control: async () => configControl,
      config: { watchDebounceMs: 60_000 },
    },
    agent: {
      guiInfo: { ...guiInfo, agentDir },
      askProjectTrust: () => true,
      attachmentStagingDir: resolve(".tmp/model-runtime/attachments"),
      createControlProcess: () => control.process,
      createSessionProcess: (request) => {
        const id = request.sessionPath
          ? basename(request.sessionPath, ".jsonl")
          : `session-${sessions.length}`;
        let snapshot = readModels();
        let selected = snapshot[0];
        const session = createProcess(async (command: NekRpcCommand) => {
          if (command.type === "get_state")
            return {
              sessionId: id,
              sessionFile: `/sessions/${id}.jsonl`,
              model: selected,
              thinkingLevel: "medium",
              isStreaming: sessionWithState.busy,
              isCompacting: false,
              messageCount: 1,
              pendingMessageCount: 0,
            };
          if (command.type === "get_entries") return { entries: [], leafId: null, hasMore: false };
          if (command.type === "get_session_stats")
            return {
              sessionId: id,
              totalMessages: 1,
              tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              cost: 0,
            };
          if (command.type === "extension_call")
            return { result: { mode: "agent", todos: [], plans: [], subagents: [] } };
          if (command.type === "get_available_models") return { models: snapshot };
          if (command.type === "get_commands") return { commands: [] };
          if (command.type === "reload") {
            const loaded = readModels();
            await hold?.();
            if (reloadError) throw new Error(reloadError);
            if (!sessionWithState.busy) snapshot = loaded;
            return { deferred: sessionWithState.busy, diagnostics } satisfies NekReloadResult;
          }
          if (command.type === "set_model") {
            const model = snapshot.find(
              (item) => item.id === command.modelId && item.provider === command.provider,
            );
            if (!model) throw new Error(`Model not found: ${command.provider}/${command.modelId}`);
            selected = model;
            return model;
          }
          if (["prompt", "steer", "follow_up"].includes(command.type))
            return { disposition: "started" };
          return {};
        });
        const sessionWithState = {
          ...session,
          busy: false,
          selected: () => selected,
          snapshot: () => snapshot,
          request,
        };
        sessions.push(sessionWithState);
        return session.process;
      },
    },
  });
  const open = async (cwd = "/project") =>
    runtime.agentService.createNekSession({ workspacePath: cwd });
  return {
    ...runtime,
    executor,
    sessions,
    control,
    open,
    restore: async (path: string, cwd = "/restored", locked = false) => {
      snapshots.set(path, {
        session: {
          id: basename(path, ".jsonl"),
          path,
          cwd,
          createdAt: "2026-01-01",
          modifiedAt: "2026-01-01",
          messageCount: 1,
          firstMessage: "saved",
          locked,
        },
        entries: [],
        messages: [],
        leafId: null,
      });
      return await runtime.agentService.resumeNekSession({ workspacePath: cwd, sessionPath: path });
    },
    failControl: (message?: string) => {
      controlFailure = message;
    },
    failReload: (message?: string) => {
      reloadError = message;
    },
    setDiagnostics: (value: NekConfigDiagnostic[]) => {
      diagnostics = value;
    },
    onReload: (fn?: () => Promise<void>) => {
      hold = fn;
    },
    dispose: async () => {
      await runtime.agentService.dispose();
      runtime.configApi.dispose();
      await control.process.dispose();
    },
  };
}
