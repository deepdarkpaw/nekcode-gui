/**
 * models.json 的高层操作：服务商、模型、改名与引用改写。
 *
 * 并发模型：`models.json` 没有锁（nek 只读它），所以每次写入都带 revision：
 * 读到的令牌与预期不一致就以 `conflict` 拒绝，界面提示"配置已在外部修改"。
 */
import type {
  NekAgentPresetEntry,
  INekConfigApi,
  NekConfigRevision,
  NekConfigTarget,
  NekProviderReferences,
} from "@zcode/shared/nek-protocol";
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";
import { NekConfigError, asNekConfigError, conflict, validationError } from "./errors.js";
import {
  modelWriteToValue,
  providerEdits,
  providerToView,
  providerWriteToValue,
  readModelsSnapshot,
  validateModelValue,
  validateProviderValue,
} from "./modelsDocument.js";
import type { NekJsoncEdit, NekModelsSnapshot } from "./modelsDocument.js";
import { modelsDiagnostics } from "./modelsDiagnostics.js";
import { readModelScopeDocuments } from "./modelScopeSettings.js";
import { writeModelsAndScope } from "./modelScopeWrite.js";
import {
  modelThinkingPatch,
  planReferenceRewrites,
  scanProviderReferences,
} from "./modelsReferences.js";
import {
  NEK_THINKING_LEVELS,
  validateNekProviderId,
  type NekProviderIdError,
} from "@zcode/shared/nek-protocol";
import { modelsPath, settingsPath } from "./paths.js";
import { listAgentPresets, writeAgentPreset } from "./presetsDocument.js";
import type { NekConfigRuntime } from "./runtime.js";
import { readSettingsDocument, type NekSettingsDocument } from "./settingsDocument.js";
import { sameRevision } from "./revision.js";

const PROVIDER_ID_ERRORS: Record<NekProviderIdError, string> = {
  required: "enter a non-empty ID",
  slash: '"/" separates the provider from the model in a provider/model reference',
  edgeWhitespace:
    "nek trims the provider prefix in a model reference, so an ID cannot start or end with whitespace",
  duplicate: "an ID already exists with that spelling; model references ignore case",
};

type RawModel = Record<string, unknown>;

export type NekModelsGroup = Pick<
  INekConfigApi,
  | "readModelsConfig"
  | "saveProvider"
  | "deleteProvider"
  | "getProviderReferences"
  | "previewProviderRename"
  | "renameProvider"
  | "saveModel"
  | "addModels"
  | "deleteModel"
  | "reorderModels"
>;

function requireProvider(snapshot: NekModelsSnapshot, providerId: string): Record<string, unknown> {
  if (!Object.hasOwn(snapshot.providers, providerId)) {
    throw validationError(`unknown provider "${providerId}"`, { providerId: "unknown" });
  }
  return snapshot.providers[providerId]!;
}

function modelsOf(provider: Record<string, unknown>): RawModel[] {
  return Array.isArray(provider.models) ? provider.models.filter(isPlainObject) : [];
}

function modelIdOf(model: RawModel): string {
  return typeof model.id === "string" ? model.id : "";
}

function requireNewProviderId(
  snapshot: NekModelsSnapshot,
  id: string,
  field: "id" | "to",
  previousId?: string,
): void {
  if (previousId !== undefined && id === previousId) {
    throw validationError("provider id did not change", { [field]: "unchanged" });
  }
  const providers = snapshot.data.providers;
  const ids = isPlainObject(providers) ? Object.keys(providers) : [];
  const issue = validateNekProviderId(id, ids, previousId);
  if (issue) {
    throw validationError(`provider ${JSON.stringify(id)}: ${PROVIDER_ID_ERRORS[issue]}`, {
      [field]: issue,
    });
  }
}

export function createModelsGroup(runtime: NekConfigRuntime): NekModelsGroup {
  const presetsOf = async (
    target: NekConfigTarget,
    cwd?: string,
  ): Promise<NekAgentPresetEntry[]> => {
    const context = runtime.target(target);
    const result = await listAgentPresets({
      executor: context.executor,
      agentDir: context.layout.agentDir,
      cwd,
      logger: runtime.logger,
    });
    return result.entries;
  };

  const referencesOf = async (
    target: NekConfigTarget,
    providerId: string,
    cwd?: string,
  ): Promise<NekProviderReferences> => {
    const { global, project } = await readModelScopeDocuments(runtime, runtime.target(target), cwd);
    const presets = await presetsOf(target, cwd);
    const references = scanProviderReferences({ providerId, settings: global.raw, presets });
    if (!project) return references;
    const projectReferences = scanProviderReferences({
      providerId,
      settings: project.raw,
      presets: [],
    });
    return {
      ...references,
      enabledModels: [
        ...new Set([...references.enabledModels, ...projectReferences.enabledModels]),
      ],
    };
  };

  const readSnapshot = async (target: NekConfigTarget): Promise<NekModelsSnapshot> => {
    const context = runtime.target(target);
    return await readModelsSnapshot(context.executor, modelsPath(context.layout));
  };

  const save = async (
    target: NekConfigTarget,
    snapshot: NekModelsSnapshot,
    options: Parameters<typeof writeModelsAndScope>[4],
    edits: readonly NekJsoncEdit[],
  ): Promise<NekConfigRevision> => {
    const { revision, written } = await writeModelsAndScope(
      runtime,
      target,
      snapshot,
      edits,
      options,
    );
    await runtime.publishWrite(target, written);
    return { revision };
  };

  return {
    /**
     * models.json 只有全局一份（`<agentDir>/models.json`），所以 `cwd` 不影响结果；
     * 参数与其它 models 方法保持一致，界面一律传当前工作区目录。
     */
    readModelsConfig: async (target, _cwd) => {
      const snapshot = await readSnapshot(target);
      return {
        path: snapshot.path,
        revision: snapshot.revision,
        providers: Object.entries(snapshot.providers).map(([id, raw]) => providerToView(id, raw)),
        diagnostics: modelsDiagnostics(snapshot),
      };
    },

    saveProvider: async (target, provider, options) => {
      if (provider.apiKey === "") {
        throw validationError("apiKey must be omitted, kept, replaced, or removed explicitly", {
          apiKey: "empty string is not a valid deletion instruction",
        });
      }
      const snapshot = await readSnapshot(target);
      if (!sameRevision(snapshot.revision, options.revision)) throw conflict(snapshot.path);
      if (options.isNew) requireNewProviderId(snapshot, provider.id, "id");
      const existing = options.isNew ? undefined : requireProvider(snapshot, provider.id);
      const value = providerWriteToValue(provider, existing);
      validateProviderValue(provider.id, value);
      return await save(target, snapshot, options, providerEdits(provider.id, existing, value));
    },

    deleteProvider: async (target, providerId, options) => {
      const snapshot = await readSnapshot(target);
      requireProvider(snapshot, providerId);
      return await save(target, snapshot, options, [
        { pointer: ["providers", providerId], value: undefined },
      ]);
    },

    getProviderReferences: referencesOf,

    previewProviderRename: async (target, from, to, cwd) => {
      const snapshot = await readSnapshot(target);
      requireProvider(snapshot, from);
      requireNewProviderId(snapshot, to, "to", from);
      return { from, to, references: await referencesOf(target, from, cwd) };
    },

    renameProvider: async (target, from, to, options) => {
      const context = runtime.target(target);
      const snapshot = await readSnapshot(target);
      const provider = requireProvider(snapshot, from);
      requireNewProviderId(snapshot, to, "to", from);
      const settingsFile = settingsPath(context.layout, "global");
      const settingsDocument = await readSettingsDocument(context.executor, settingsFile);
      const presets = await presetsOf(target, options.cwd);
      const plan = planReferenceRewrites({
        providerId: from,
        to,
        settings: settingsDocument.raw,
        presets,
      });
      const { revision, written } = await writeModelsAndScope(
        runtime,
        target,
        snapshot,
        [
          { pointer: ["providers", to], value: provider },
          { pointer: ["providers", from], value: undefined },
        ],
        {
          ...options,
          rename: { kind: "provider", from, to },
          globalSettings: { document: settingsDocument, patch: () => plan.settingsPatch },
        },
      );
      try {
        for (const rewrite of plan.presetRewrites) {
          const entry = presets.find((candidate) => candidate.path === rewrite.path);
          if (!entry) continue;
          const result = await writeAgentPreset({
            executor: context.executor,
            agentDir: context.layout.agentDir,
            scope: rewrite.scope,
            preset: { ...entry.preset, model: rewrite.to },
            expectedRevision: entry.revision,
            cwd: options.cwd,
          });
          written.push({ path: result.path, revision: result.revision });
          if (result.removedPath) written.push({ path: result.removedPath, revision: "absent" });
        }
      } catch (error) {
        // 部分成功必须说清楚：models.json 已经改名，后续文件需要重新载入后再处理。
        await runtime.publishWrite(target, written);
        const normalized = asNekConfigError(error);
        throw new NekConfigError(
          "io",
          `provider "${from}" was renamed to "${to}", but updating a preset failed: ${normalized.message}`,
          normalized.fieldErrors,
        );
      }
      await runtime.publishWrite(target, written);
      return { revision };
    },

    saveModel: async (target, providerId, model, options) => {
      const snapshot = await readSnapshot(target);
      const models = modelsOf(requireProvider(snapshot, providerId));
      const key = options.previousId ?? model.id;
      const existing = models.some((entry) => modelIdOf(entry) === key);
      if (options.previousId !== undefined && !existing) {
        throw validationError(`unknown model "${key}"`, { modelId: "unknown" });
      }
      if (model.id !== key && models.some((entry) => modelIdOf(entry) === model.id)) {
        throw validationError(`model "${model.id}" already exists`, { id: "duplicate" });
      }
      validateModelValue(providerId, model);
      const value = modelWriteToValue(model);
      const rename =
        key === model.id
          ? undefined
          : {
              kind: "model" as const,
              provider: providerId,
              from: key,
              to: model.id,
            };
      const level = options.defaultThinkingLevel;
      if (level != null && !NEK_THINKING_LEVELS.includes(level)) {
        throw validationError(`invalid default thinking level "${level}"`, {
          defaultThinkingLevel: "invalid",
        });
      }
      const globalSettings =
        rename || level !== undefined
          ? {
              patch: (settings: NekSettingsDocument) =>
                modelThinkingPatch(settings.values, providerId, key, model.id, level),
            }
          : undefined;
      return await save(target, snapshot, { ...options, rename, globalSettings }, [
        {
          pointer: ["providers", providerId, "models"],
          value: existing
            ? models.map((entry) => (modelIdOf(entry) === key ? value : entry))
            : [...models, value],
        },
      ]);
    },

    addModels: async (target, providerId, added, options) => {
      const snapshot = await readSnapshot(target);
      const models = modelsOf(requireProvider(snapshot, providerId));
      const ids = new Set(models.map(modelIdOf));
      for (const model of added) {
        if (ids.has(model.id))
          throw validationError(`model "${model.id}" already exists`, { id: "duplicate" });
        ids.add(model.id);
        validateModelValue(providerId, model);
      }
      return await save(target, snapshot, options, [
        {
          pointer: ["providers", providerId, "models"],
          value: [...models, ...added.map((model) => modelWriteToValue(model))],
        },
      ]);
    },

    deleteModel: async (target, providerId, modelId, options) => {
      const snapshot = await readSnapshot(target);
      const models = modelsOf(requireProvider(snapshot, providerId));
      if (!models.some((entry) => modelIdOf(entry) === modelId)) {
        throw validationError(`unknown model "${modelId}"`, { modelId: "unknown" });
      }
      return await save(target, snapshot, options, [
        {
          pointer: ["providers", providerId, "models"],
          value: models.filter((entry) => modelIdOf(entry) !== modelId),
        },
      ]);
    },

    reorderModels: async (target, providerId, modelIds, options) => {
      const snapshot = await readSnapshot(target);
      const models = modelsOf(requireProvider(snapshot, providerId));
      const byId = new Map(models.map((entry) => [modelIdOf(entry), entry]));
      const ordered: RawModel[] = [];
      for (const id of modelIds) {
        const entry = byId.get(id);
        if (!entry)
          throw validationError(`unknown model "${id}"`, { modelIds: `unknown model ${id}` });
        ordered.push(entry);
        byId.delete(id);
      }
      // 未列出的模型按原顺序追加到末尾（界面只发它看到的顺序）。
      for (const entry of models) {
        const id = modelIdOf(entry);
        if (byId.has(id)) ordered.push(entry);
      }
      return await save(target, snapshot, options, [
        { pointer: ["providers", providerId, "models"], value: ordered },
      ]);
    },
  };
}
