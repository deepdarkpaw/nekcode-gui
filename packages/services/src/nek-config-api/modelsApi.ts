/**
 * models.json 的高层操作：服务商、模型、改名与引用改写。
 *
 * 并发模型：`models.json` 没有锁（nek 只读它），所以每次写入都带 revision：
 * 读到的令牌与预期不一致就以 `conflict` 拒绝，界面提示"配置已在外部修改"。
 */
import type {
  NekAgentPresetEntry,
  NekConfigDiagnostic,
  NekConfigRevision,
  NekConfigTarget,
  NekModelConfig,
  NekModelsConfigView,
  NekProviderRenamePreview,
  NekProviderReferences,
  NekProviderWrite,
} from "@zcode/shared/nek-protocol";
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";
import { NekConfigError, asNekConfigError, conflict, validationError } from "./errors.js";
import {
  editModelsSnapshot,
  modelWriteToValue,
  providerEdits,
  providerToView,
  providerWriteToValue,
  readModelsSnapshot,
  validateModelValue,
  validateProviderValue,
} from "./modelsDocument.js";
import type { NekJsoncEdit, NekModelsSnapshot } from "./modelsDocument.js";
import { planReferenceRewrites, scanProviderReferences } from "./modelsReferences.js";
import { modelsPath, settingsPath } from "./paths.js";
import { listAgentPresets, writeAgentPreset } from "./presetsDocument.js";
import type { NekConfigRuntime } from "./runtime.js";
import { patchSettingsDocument, readSettingsDocument } from "./settingsDocument.js";
import { sameRevision } from "./revision.js";

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

type RawModel = Record<string, unknown>;

export interface NekModelsGroup {
  readModelsConfig: (target: NekConfigTarget) => Promise<NekModelsConfigView>;
  saveProvider: (
    target: NekConfigTarget,
    provider: NekProviderWrite,
    options: { revision: string; isNew: boolean },
  ) => Promise<NekConfigRevision>;
  deleteProvider: (
    target: NekConfigTarget,
    providerId: string,
    options: { revision: string },
  ) => Promise<NekConfigRevision>;
  getProviderReferences: (
    target: NekConfigTarget,
    providerId: string,
  ) => Promise<NekProviderReferences>;
  previewProviderRename: (
    target: NekConfigTarget,
    from: string,
    to: string,
  ) => Promise<NekProviderRenamePreview>;
  renameProvider: (
    target: NekConfigTarget,
    from: string,
    to: string,
    options: { revision: string },
  ) => Promise<NekConfigRevision>;
  saveModel: (
    target: NekConfigTarget,
    providerId: string,
    model: NekModelConfig,
    options: { revision: string; previousId?: string },
  ) => Promise<NekConfigRevision>;
  addModels: (
    target: NekConfigTarget,
    providerId: string,
    models: NekModelConfig[],
    options: { revision: string },
  ) => Promise<NekConfigRevision>;
  deleteModel: (
    target: NekConfigTarget,
    providerId: string,
    modelId: string,
    options: { revision: string },
  ) => Promise<NekConfigRevision>;
  reorderModels: (
    target: NekConfigTarget,
    providerId: string,
    modelIds: string[],
    options: { revision: string },
  ) => Promise<NekConfigRevision>;
}

/** models.json 的结构性问题（nek 启动时也会报，GUI 提前显示）。 */
function modelsDiagnostics(snapshot: NekModelsSnapshot): NekConfigDiagnostic[] {
  const diagnostics: NekConfigDiagnostic[] = [];
  for (const [id, provider] of Object.entries(snapshot.providers)) {
    if (typeof provider.api !== "string" || provider.api === "") {
      diagnostics.push({
        file: snapshot.path,
        severity: "warning",
        message: `provider "${id}" has no "api"; nek falls back to the built-in default`,
      });
    }
    if (typeof provider.baseUrl !== "string" || provider.baseUrl === "") {
      diagnostics.push({
        file: snapshot.path,
        severity: "warning",
        message: `provider "${id}" has no "baseUrl"`,
      });
    }
  }
  return diagnostics;
}

function requireProvider(snapshot: NekModelsSnapshot, providerId: string): Record<string, unknown> {
  const provider = snapshot.providers[providerId];
  if (!provider) throw validationError(`unknown provider "${providerId}"`, { providerId: "unknown" });
  return provider;
}

function modelsOf(provider: Record<string, unknown>): RawModel[] {
  return Array.isArray(provider.models) ? provider.models.filter(isPlainObject) : [];
}

function modelIdOf(model: RawModel): string {
  return typeof model.id === "string" ? model.id : "";
}

function requireProviderId(id: string, field: string): void {
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw validationError(`invalid provider id "${id}"`, { [field]: "use lowercase letters, digits and dashes" });
  }
}

export function createModelsGroup(runtime: NekConfigRuntime): NekModelsGroup {
  const settingsOf = async (target: NekConfigTarget): Promise<{ raw: Record<string, unknown>; revision: string }> => {
    const context = runtime.target(target);
    const document = await readSettingsDocument(context.executor, settingsPath(context.layout, "global"));
    return { raw: document.raw, revision: document.revision };
  };

  const presetsOf = async (target: NekConfigTarget): Promise<NekAgentPresetEntry[]> => {
    const context = runtime.target(target);
    return await listAgentPresets({
      executor: context.executor,
      agentDir: context.layout.agentDir,
      cwd: runtime.cwdHint(target),
      logger: runtime.logger,
    });
  };

  const readSnapshot = async (target: NekConfigTarget): Promise<NekModelsSnapshot> => {
    const context = runtime.target(target);
    return await readModelsSnapshot(context.executor, modelsPath(context.layout));
  };

  const save = async (
    target: NekConfigTarget,
    snapshot: NekModelsSnapshot,
    expectedRevision: string,
    edits: readonly NekJsoncEdit[],
  ): Promise<NekConfigRevision> => {
    const { executor } = runtime.target(target);
    const revision = await editModelsSnapshot(executor, snapshot, expectedRevision, edits);
    runtime.publishWrite(target, [{ path: snapshot.path, revision }]);
    return { revision };
  };

  return {
    readModelsConfig: async (target) => {
      const snapshot = await readSnapshot(target);
      return {
        path: snapshot.path,
        revision: snapshot.revision,
        providers: Object.entries(snapshot.providers).map(([id, raw]) => providerToView(id, raw)),
        diagnostics: modelsDiagnostics(snapshot),
      };
    },

    saveProvider: async (target, provider, options) => {
      requireProviderId(provider.id, "id");
      const snapshot = await readSnapshot(target);
      if (!sameRevision(snapshot.revision, options.revision)) throw conflict(snapshot.path);
      const existing = snapshot.providers[provider.id];
      if (options.isNew && existing) {
        throw validationError(`provider "${provider.id}" already exists`, { id: "duplicate" });
      }
      const value = providerWriteToValue(provider, existing);
      validateProviderValue(provider.id, value);
      return await save(target, snapshot, options.revision, providerEdits(provider.id, existing, value));
    },

    deleteProvider: async (target, providerId, options) => {
      const snapshot = await readSnapshot(target);
      requireProvider(snapshot, providerId);
      return await save(target, snapshot, options.revision, [
        { pointer: ["providers", providerId], value: undefined },
      ]);
    },

    getProviderReferences: async (target, providerId) =>
      scanProviderReferences({
        providerId,
        settings: (await settingsOf(target)).raw,
        presets: await presetsOf(target),
      }),

    previewProviderRename: async (target, from, to) => {
      const snapshot = await readSnapshot(target);
      requireProvider(snapshot, from);
      requireProviderId(to, "to");
      if (snapshot.providers[to]) {
        throw validationError(`provider "${to}" already exists`, { to: "duplicate" });
      }
      const settings = await settingsOf(target);
      return {
        from,
        to,
        references: scanProviderReferences({
          providerId: from,
          settings: settings.raw,
          presets: await presetsOf(target),
        }),
      };
    },

    renameProvider: async (target, from, to, options) => {
      if (from === to) throw validationError("provider id did not change", { to: "unchanged" });
      requireProviderId(to, "to");
      const context = runtime.target(target);
      const snapshot = await readSnapshot(target);
      const provider = requireProvider(snapshot, from);
      if (snapshot.providers[to]) {
        throw validationError(`provider "${to}" already exists`, { to: "duplicate" });
      }
      const settingsFile = settingsPath(context.layout, "global");
      const settingsDocument = await readSettingsDocument(context.executor, settingsFile);
      const presets = await presetsOf(target);
      const plan = planReferenceRewrites({
        providerId: from,
        to,
        settings: settingsDocument.raw,
        presets,
      });
      // 先写新键再删旧键：中途失败最多留下一个重复 provider，不会丢掉配置。
      const revision = await editModelsSnapshot(context.executor, snapshot, options.revision, [
        { pointer: ["providers", to], value: provider },
        { pointer: ["providers", from], value: undefined },
      ]);
      const written: Array<{ path: string; revision: string }> = [{ path: snapshot.path, revision }];
      const applied: string[] = [snapshot.path];
      try {
        if (Object.keys(plan.settingsPatch).length > 0) {
          const patched = await patchSettingsDocument({
            executor: context.executor,
            path: settingsFile,
            patch: plan.settingsPatch,
            expectedRevision: settingsDocument.revision,
          });
          written.push({ path: patched.path, revision: patched.revision });
          applied.push(patched.path);
        }
        for (const rewrite of plan.presetRewrites) {
          const entry = presets.find((candidate) => candidate.path === rewrite.path);
          if (!entry) continue;
          const result = await writeAgentPreset({
            executor: context.executor,
            agentDir: context.layout.agentDir,
            scope: rewrite.scope,
            preset: { ...entry.preset, model: rewrite.to },
            expectedRevision: entry.revision,
            cwd: runtime.cwdHint(target),
          });
          written.push({ path: result.path, revision: result.revision });
          if (result.removedPath) written.push({ path: result.removedPath, revision: "absent" });
          applied.push(result.path);
        }
      } catch (error) {
        // 部分成功必须说清楚：models.json 已经改名，后续文件需要重新载入后再处理。
        const normalized = asNekConfigError(error);
        throw new NekConfigError(
          normalized.code,
          `provider "${from}" was renamed to "${to}" in ${applied.join(", ")}, but a later step failed: ${normalized.message}`,
          normalized.fieldErrors,
        );
      }
      runtime.publishWrite(target, written);
      return { revision };
    },

    saveModel: async (target, providerId, model, options) => {
      const snapshot = await readSnapshot(target);
      const models = modelsOf(requireProvider(snapshot, providerId));
      const key = options.previousId ?? model.id;
      if (model.id !== key && models.some((entry) => modelIdOf(entry) === model.id)) {
        throw validationError(`model "${model.id}" already exists`, { id: "duplicate" });
      }
      validateModelValue(providerId, model);
      const value = modelWriteToValue(model);
      return await save(target, snapshot, options.revision, [
        {
          pointer: ["providers", providerId, "models"],
          value: models.some((entry) => modelIdOf(entry) === key)
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
        if (ids.has(model.id)) throw validationError(`model "${model.id}" already exists`, { id: "duplicate" });
        ids.add(model.id);
        validateModelValue(providerId, model);
      }
      return await save(target, snapshot, options.revision, [
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
      return await save(target, snapshot, options.revision, [
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
        if (!entry) throw validationError(`unknown model "${id}"`, { modelIds: `unknown model ${id}` });
        ordered.push(entry);
        byId.delete(id);
      }
      // 未列出的模型按原顺序追加到末尾（界面只发它看到的顺序）。
      for (const entry of models) {
        const id = modelIdOf(entry);
        if (byId.has(id)) ordered.push(entry);
      }
      return await save(target, snapshot, options.revision, [
        { pointer: ["providers", providerId, "models"], value: ordered },
      ]);
    },
  };
}
