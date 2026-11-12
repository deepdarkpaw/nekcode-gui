/**
 * mock：models.json、模型目录、拉取模型、测试连接、引用与改 ID。
 */
import type {
  NekCatalogModel,
  NekFetchModelsResult,
  NekModelConfig,
  NekProviderConfig,
  NekProviderDraft,
  NekProviderReferences,
  NekProviderView,
  NekProviderWrite,
  NekRemoteModel,
  NekTestProviderResult,
  NekThinkingLevel,
} from "@zcode/shared/nek-protocol";
import { NEK_THINKING_LEVELS } from "@zcode/shared/nek-protocol";
import { apiKeyViewFromWrite } from "../modelsDoc.js";
import {
  assertRevision,
  clone,
  mockError,
  type MockFile,
  type MockMachine,
} from "./mockMachine.js";
import { MOCK_CATALOG } from "./mockSeed.js";

export type Touch = (file: MockFile<unknown>) => string;

export function providerView(provider: NekProviderConfig): NekProviderView {
  const { apiKey, ...rest } = provider;
  return {
    ...clone(rest),
    apiKey: apiKeyViewFromWrite(apiKey, undefined),
    overridesBuiltin: provider.id === "anthropic" || provider.id === "openai",
  };
}

export function findProvider(machine: MockMachine, id: string): NekProviderConfig {
  const provider = machine.models.value.find((item) => item.id === id);
  if (!provider) {
    throw mockError("validation", `Unknown provider: ${id}`, { id: "unknown" });
  }
  return provider;
}

export function saveProvider(
  machine: MockMachine,
  write: NekProviderWrite,
  options: { revision: string; isNew: boolean },
  touch: Touch,
): string {
  assertRevision(machine.models, options.revision);
  const existing = machine.models.value.find((item) => item.id === write.id);
  if (options.isNew && existing) {
    throw mockError("validation", `Provider ${write.id} already exists`, { id: "duplicate" });
  }
  if (options.isNew && !/^[a-z0-9][a-z0-9-]*$/.test(write.id)) {
    throw mockError("validation", "Invalid provider id", { id: "format" });
  }
  if (write.apiKey === "") {
    throw mockError("validation", "Empty API key is not a valid deletion instruction", {
      apiKey: "empty",
    });
  }
  const { apiKey, ...rest } = write;
  const resolvedKey =
    apiKey === undefined
      ? existing?.apiKey
      : typeof apiKey === "object"
        ? "remove" in apiKey
          ? undefined
          : existing?.apiKey
        : apiKey;
  const next: NekProviderConfig = {
    ...clone(rest),
    api: rest.api ?? "",
    ...(resolvedKey ? { apiKey: resolvedKey } : {}),
  };
  machine.models.value = existing
    ? machine.models.value.map((item) => (item.id === write.id ? next : item))
    : [...machine.models.value, next];
  return touch(machine.models);
}

export function updateModels(
  machine: MockMachine,
  providerId: string,
  revision: string,
  update: (models: NekModelConfig[]) => NekModelConfig[],
  touch: Touch,
): string {
  assertRevision(machine.models, revision);
  const provider = findProvider(machine, providerId);
  provider.models = update(provider.models);
  return touch(machine.models);
}

export function saveModel(
  models: NekModelConfig[],
  model: NekModelConfig,
  previousId?: string,
): NekModelConfig[] {
  const key = previousId ?? model.id;
  if (model.id !== key && models.some((item) => item.id === model.id)) {
    throw mockError("validation", `Model ${model.id} already exists`, { id: "duplicate" });
  }
  const exists = models.some((item) => item.id === key);
  return exists
    ? models.map((item) => (item.id === key ? clone(model) : item))
    : [...models, clone(model)];
}

export function addModels(models: NekModelConfig[], added: NekModelConfig[]): NekModelConfig[] {
  const ids = new Set(models.map((model) => model.id));
  const duplicate = added.find((model) => ids.has(model.id));
  if (duplicate) {
    throw mockError("validation", `Model ${duplicate.id} already exists`, { id: "duplicate" });
  }
  return [...models, ...clone(added)];
}

export function reorderModels(models: NekModelConfig[], ids: string[]): NekModelConfig[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const ordered = ids.flatMap((id) => {
    const model = byId.get(id);
    return model ? [model] : [];
  });
  return [...ordered, ...models.filter((model) => !ids.includes(model.id))];
}

function thinkingLevelsOf(model: NekModelConfig): NekThinkingLevel[] {
  if (!model.reasoning) {
    return [];
  }
  return NEK_THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
}

export function availableModels(machine: MockMachine): NekCatalogModel[] {
  const custom = machine.models.value.flatMap((provider) =>
    provider.models.map<NekCatalogModel>((model) => ({
      provider: provider.id,
      id: model.id,
      name: model.name ?? model.id,
      api: model.api ?? provider.api,
      contextWindow: model.contextWindow ?? 128_000,
      maxTokens: model.maxTokens ?? 16_384,
      reasoning: model.reasoning === true,
      thinkingLevels: thinkingLevelsOf(model),
      thinkingLevelMap: model.thinkingLevelMap,
      input: model.input ?? ["text"],
      cost: model.cost,
    })),
  );
  const oauth = MOCK_CATALOG.filter((model) => machine.auth.get(model.provider)?.kind === "oauth");
  return [...oauth, ...custom];
}

export function catalog(ids?: string[]): NekCatalogModel[] {
  return ids ? MOCK_CATALOG.filter((model) => ids.includes(model.id)) : clone(MOCK_CATALOG);
}

function draftOf(
  machine: MockMachine,
  source: { providerId: string; draft?: NekProviderDraft },
): NekProviderDraft {
  const provider = findProvider(machine, source.providerId);
  if (source.draft) {
    return {
      ...source.draft,
      apiKey: source.draft.apiKey ?? provider.apiKey,
    };
  }

  return {
    api: provider.api as NekProviderDraft["api"],
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
  };
}

type Failure = { status?: number; message: string };

function simulateFailure(draft: NekProviderDraft): Failure | null {
  if (draft.baseUrl.includes("nolist")) {
    return { status: 404, message: "404 Not Found" };
  }
  if ((draft.apiKey ?? "").includes("bad")) {
    return { status: 401, message: "401 Unauthorized: invalid x-api-key" };
  }
  if (draft.baseUrl.includes("localhost")) {
    return { message: "connect ECONNREFUSED 127.0.0.1:11434" };
  }
  return null;
}

const REMOTE_LISTS: Record<string, NekRemoteModel[]> = {
  "anthropic-messages": [
    {
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      contextWindow: 200_000,
      maxTokens: 64_000,
      reasoning: true,
      thinkingLevels: ["off", "low", "medium", "high"],
      input: ["text", "image"],
    },
    {
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      contextWindow: 200_000,
      maxTokens: 64_000,
      reasoning: true,
      thinkingLevels: ["off", "low", "medium", "high"],
      input: ["text", "image"],
    },
    { id: "claude-opus-4-1", name: "Claude Opus 4.1" },
  ],
  "google-generative-ai": [
    {
      id: "gemini-2.5-pro",
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      reasoning: true,
      thinkingLevels: ["low", "medium", "high"],
    },
    { id: "gemini-2.5-flash", contextWindow: 1_048_576, maxTokens: 65_536 },
  ],
  default: [
    { id: "deepseek-chat" },
    { id: "deepseek-reasoner" },
    { id: "gpt-4.1" },
    { id: "gpt-4.1-mini" },
    { id: "qwen3-coder-plus" },
    { id: "my-finetune-001" },
  ],
};

export function fetchModels(
  machine: MockMachine,
  source: { providerId: string; draft?: NekProviderDraft },
): NekFetchModelsResult {
  const draft = draftOf(machine, source);
  const endpoint = `${draft.baseUrl.replace(/\/+$/, "")}/models`;
  const failure = simulateFailure(draft);
  if (failure) {
    return { ok: false, endpoint, ...failure };
  }
  return {
    ok: true,
    endpoint,
    models: clone(REMOTE_LISTS[draft.api] ?? REMOTE_LISTS.default ?? []),
  };
}

export function testProvider(
  machine: MockMachine,
  source: { providerId: string; draft?: NekProviderDraft },
  modelId: string,
): NekTestProviderResult {
  const failure = simulateFailure(draftOf(machine, source));
  if (failure) {
    return { ok: false, ...failure };
  }
  return { ok: true, latencyMs: 180 + ((modelId.length * 37) % 400) };
}

export function references(machine: MockMachine, providerId: string): NekProviderReferences {
  const settings = machine.settings.value;
  const prefix = `${providerId}/`;
  return {
    defaultModel: settings.defaultProvider === providerId,
    enabledModels: (settings.enabledModels ?? []).filter((ref) => ref.startsWith(prefix)),
    compactionModel: settings.compaction?.model?.startsWith(prefix) === true,
    modelThinkingLevels: Object.keys(settings.modelThinkingLevels ?? {}).filter((ref) =>
      ref.startsWith(prefix),
    ),
    agentPresets: machine.presets
      .filter((entry) => entry.preset.model?.startsWith(prefix) && entry.path)
      .map((entry) => ({ name: entry.preset.name, path: entry.path ?? "" })),
  };
}

function renameRef(ref: string | undefined, from: string, to: string): string | undefined {
  return ref?.startsWith(`${from}/`) ? `${to}/${ref.slice(from.length + 1)}` : ref;
}

export function renameProvider(
  machine: MockMachine,
  from: string,
  to: string,
  revision: string,
  touch: Touch,
): string {
  assertRevision(machine.models, revision);
  if (machine.models.value.some((provider) => provider.id === to)) {
    throw mockError("validation", `Provider ${to} already exists`, { id: "duplicate" });
  }
  findProvider(machine, from).id = to;
  const settings = machine.settings.value;
  if (settings.defaultProvider === from) {
    settings.defaultProvider = to;
  }
  settings.enabledModels = settings.enabledModels?.map((ref) => renameRef(ref, from, to) ?? ref);
  if (settings.compaction?.model) {
    settings.compaction.model = renameRef(settings.compaction.model, from, to);
  }
  if (settings.modelThinkingLevels) {
    settings.modelThinkingLevels = Object.fromEntries(
      Object.entries(settings.modelThinkingLevels).map(([ref, level]) => [
        renameRef(ref, from, to) ?? ref,
        level,
      ]),
    );
  }
  touch(machine.settings);
  for (const entry of machine.presets) {
    if (entry.preset.model?.startsWith(`${from}/`) && entry.path) {
      entry.preset.model = renameRef(entry.preset.model, from, to);
      entry.revision = touch({ path: entry.path, revision: entry.revision, value: null });
    }
  }
  return touch(machine.models);
}
