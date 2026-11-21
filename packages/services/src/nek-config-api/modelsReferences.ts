/**
 * 服务商 / 模型引用的扫描与改写。
 *
 * 可定位的引用以 `provider/` 开头。范围数组统一由 `modelScopeReferences` 改写；本模块扫描影响，
 * 并处理服务商改名时其它原有引用：`defaultProvider`、`defaultModel`、`compaction.model`、
 * `compaction.modelOverrides`（键）、`modelThinkingLevels`（键），以及子代理预设的 `model`。
 */
import type {
  NekAgentPresetEntry,
  NekConfigScope,
  NekProviderReferences,
  NekSettingsView,
  NekThinkingLevel,
} from "@zcode/shared/nek-protocol";
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";

/** `provider/model[:level]` → 换 provider；不匹配返回 null。 */
export function rewriteModelReference(reference: string, from: string, to: string): string | null {
  const prefix = `${from}/`;
  if (!reference.startsWith(prefix)) return null;
  return `${to}/${reference.slice(prefix.length)}`;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function recordField(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return isPlainObject(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

export interface ReferenceScanArgs {
  providerId: string;
  /** settings.json 的原始对象。 */
  settings: Record<string, unknown>;
  presets: readonly NekAgentPresetEntry[];
}

/** 列出某个服务商当前被引用的位置（用于"删除服务商"的影响预览）。 */
export function scanProviderReferences(args: ReferenceScanArgs): NekProviderReferences {
  const { providerId, settings, presets } = args;
  const prefix = `${providerId}/`;
  const compaction = recordField(settings, "compaction");
  const thinkingLevels = recordField(settings, "modelThinkingLevels");
  const defaultModel = stringField(settings, "defaultModel");
  return {
    defaultModel:
      settings.defaultProvider === providerId || (defaultModel?.startsWith(prefix) ?? false),
    enabledModels: (stringArray(settings.enabledModels) ?? []).filter((ref) =>
      ref.trim().toLowerCase().startsWith(prefix.toLowerCase()),
    ),
    compactionModel: (stringField(compaction, "model") ?? "").startsWith(prefix),
    modelThinkingLevels: Object.keys(thinkingLevels ?? {}).filter((ref) => ref.startsWith(prefix)),
    agentPresets: presets
      .filter((entry) => entry.path !== undefined && (entry.preset.model ?? "").startsWith(prefix))
      .map((entry) => ({ name: entry.preset.name, path: entry.path ?? "" })),
  };
}

export interface ProviderRenamePlan {
  from: string;
  to: string;
  /** settings.json 的补丁；旧键用 `null` 删除（合并器语义）。 */
  settingsPatch: Record<string, unknown>;
  /** 需要改写 `model` 的预设（自带 revision，写入时校验）。 */
  presetRewrites: Array<{
    name: string;
    scope: NekConfigScope;
    path: string;
    revision: string;
    from: string;
    to: string;
  }>;
  references: NekProviderReferences;
}

/** 计算改名影响：settings 补丁 + 预设改写清单。纯函数，便于预览与执行共用。 */
export function planReferenceRewrites(
  args: ReferenceScanArgs & { to: string },
): ProviderRenamePlan {
  const { providerId: from, to, settings, presets } = args;
  const patch: Record<string, unknown> = {};
  if (settings.defaultProvider === from) patch.defaultProvider = to;
  const defaultModel = stringField(settings, "defaultModel");
  if (defaultModel) {
    const rewritten = rewriteModelReference(defaultModel, from, to);
    if (rewritten) patch.defaultModel = rewritten;
  }
  const compaction = recordField(settings, "compaction");
  const compactionModel = stringField(compaction, "model");
  const rewrittenCompaction = compactionModel
    ? rewriteModelReference(compactionModel, from, to)
    : null;
  if (rewrittenCompaction) patch.compaction = { model: rewrittenCompaction };
  const overrides = recordField(compaction, "modelOverrides");
  const overridePatch = rewriteRecordKeys(overrides, from, to);
  if (overridePatch) {
    patch.compaction = { ...recordField(patch, "compaction"), modelOverrides: overridePatch };
  }
  const thinkingPatch = rewriteRecordKeys(recordField(settings, "modelThinkingLevels"), from, to);
  if (thinkingPatch) patch.modelThinkingLevels = thinkingPatch;

  const presetRewrites: ProviderRenamePlan["presetRewrites"] = [];
  for (const entry of presets) {
    if (entry.path === undefined) continue;
    const model = entry.preset.model;
    if (!model) continue;
    const rewritten = rewriteModelReference(model, from, to);
    if (!rewritten) continue;
    presetRewrites.push({
      name: entry.preset.name,
      scope: entry.source === "project" ? "project" : "global",
      path: entry.path,
      revision: entry.revision,
      from: model,
      to: rewritten,
    });
  }
  return {
    from,
    to,
    settingsPatch: patch,
    presetRewrites,
    references: scanProviderReferences({ providerId: from, settings, presets }),
  };
}

/** 和范围写入合并，避免保存模型后再拿已失效的 settings revision 更新该模型的档位。 */
export function modelThinkingPatch(
  values: NekSettingsView,
  provider: string,
  previousId: string,
  modelId: string,
  level?: NekThinkingLevel | null,
): Record<string, unknown> {
  const previous = `${provider}/${previousId}`;
  const next = `${provider}/${modelId}`;
  const levels = values.modelThinkingLevels ?? {};
  const patch: Record<string, NekThinkingLevel | null> = {};
  if (previous !== next && levels[previous] !== undefined) patch[previous] = null;
  const desired = level === undefined ? levels[previous] : level;
  if (desired !== undefined && (desired ?? undefined) !== levels[next]) patch[next] = desired;
  return Object.keys(patch).length ? { modelThinkingLevels: patch } : {};
}

/** 键需要改名的对象：新键带上原值，旧键写 `null`（删除）。 */
function rewriteRecordKeys(
  record: Record<string, unknown> | undefined,
  from: string,
  to: string,
): Record<string, unknown> | null {
  if (!record) return null;
  const rewritten: Record<string, unknown> = {};
  let changed = false;
  for (const [key, value] of Object.entries(record)) {
    const next = rewriteModelReference(key, from, to);
    if (!next) continue;
    changed = true;
    rewritten[key] = null;
    rewritten[next] = value;
  }
  return changed ? rewritten : null;
}
