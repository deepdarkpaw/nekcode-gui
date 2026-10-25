import type { NekConfigRevision } from "./nekConfigFs.js";
import type { NekConfigFs } from "./nekConfigFs.js";
import { sameRevision } from "./nekConfigFs.js";
import { readModels, removeProvider, upsertProvider } from "./nekConfigModels.js";
import type { NekModelsDocument } from "./nekConfigModels.js";
import type {
  NekAgentPresetDocument,
  NekConfigDocument,
  NekConfigScope,
  NekConfigService,
} from "./nekConfigService.js";

/**
 * 服务商 ID 改名：先算影响（plan），再由用户确认后执行（apply）。
 *
 * 引用的唯一形状是 `provider/modelId`（可带 `:thinking` 后缀）。裸 id 与 glob 模式不改写，
 * 因为它们并不指向某个具体的 provider。
 */

// ============================================================================
// 服务商 ID 改名（含引用改写）
// ============================================================================

export interface NekReferenceRewrite {
  /** 字段/文件位置的人类可读描述，例如 `settings.json: enabledModels[2]`。 */
  location: string;
  from: string;
  to: string;
}

export interface NekProviderRenamePlan {
  from: string;
  to: string;
  models: {
    path: string;
    revision: NekConfigRevision | null;
    providerExists: boolean;
    modelCount: number;
  };
  settings: {
    path: string;
    revision: NekConfigRevision | null;
    patch: Record<string, unknown>;
    /** 键集合发生变化的字段：整体替换，否则旧键会留下。 */
    replaceKeys: string[];
    rewrites: NekReferenceRewrite[];
  };
  agents: Array<{
    name: string;
    scope: NekConfigScope;
    path: string;
    revision: NekConfigRevision | null;
    rewrite: NekReferenceRewrite;
  }>;
  /** 阻止执行的问题（例如目标 ID 已存在）。 */
  blockers: string[];
}

/**
 * 模型引用的改写规则：只认 `provider/modelId` 前缀（可带 `:thinking` 后缀）。
 * 裸 id（不含 provider）与 glob 模式里的 `*` 都不改写 —— 它们不指向这个 provider。
 */
export function rewriteModelReference(reference: string, from: string, to: string): string | null {
  const prefix = `${from}/`;
  if (!reference.startsWith(prefix)) return null;
  return `${to}/${reference.slice(prefix.length)}`;
}

function rewriteRecordKeys(
  record: Record<string, unknown> | undefined,
  from: string,
  to: string,
): { next: Record<string, unknown>; rewrites: NekReferenceRewrite[] } {
  if (!record) return { next: {}, rewrites: [] };
  const next: Record<string, unknown> = {};
  const rewrites: NekReferenceRewrite[] = [];
  for (const [key, value] of Object.entries(record)) {
    const rewritten = rewriteModelReference(key, from, to);
    if (rewritten === null) {
      next[key] = value;
      continue;
    }
    next[rewritten] = value;
    rewrites.push({ location: `key ${key}`, from: key, to: rewritten });
  }
  return { next, rewrites };
}

/**
 * 计算改名影响：models.json / settings.json / agents 预设里的引用。
 *
 * 先算再执行（"先返回影响预览，再执行"）：调用方把 plan 展示给用户，
 * 确认后把它原样交给 {@link applyProviderRename}；执行时还会校验 revision，
 * 期间被外部改过就整体拒绝。
 */
export async function planProviderRenameWith(args: {
  fs: NekConfigFs;
  modelsPath: string;
  /** 只需要读 settings 与列预置这两件事。 */
  settingsSource: Pick<NekConfigService, "readSettings" | "listAgentPresets">;
  from: string;
  to: string;
}): Promise<NekProviderRenamePlan> {
  const { fs, modelsPath, from, to } = args;
  if (from === to) throw new Error("provider id did not change");
  const models = await readModels(fs, modelsPath);
  const provider = models.data.providers[from];
  const blockers: string[] = [];
  if (!provider) blockers.push(`provider "${from}" is not configured`);
  if (models.data.providers[to]) blockers.push(`provider "${to}" already exists`);

  const settings = await args.settingsSource.readSettings("global");
  const settingsRewrites: NekReferenceRewrite[] = [];
  const patch: Record<string, unknown> = {};
  const replaceKeys: string[] = [];

  if (settings.data.defaultProvider === from) {
    patch.defaultProvider = to;
    settingsRewrites.push({ location: "settings.json: defaultProvider", from, to });
  }
  const enabledModels = settings.data.enabledModels;
  if (enabledModels) {
    const next = enabledModels.map((entry, index) => {
      const rewritten = rewriteModelReference(entry, from, to);
      if (rewritten === null) return entry;
      settingsRewrites.push({
        location: `settings.json: enabledModels[${index}]`,
        from: entry,
        to: rewritten,
      });
      return rewritten;
    });
    if (next.some((entry, index) => entry !== enabledModels[index])) patch.enabledModels = next;
  }
  const compactionModel = settings.data.compaction?.model;
  if (compactionModel) {
    const rewritten = rewriteModelReference(compactionModel, from, to);
    if (rewritten) {
      patch.compaction = { ...settings.data.compaction, model: rewritten };
      replaceKeys.push("compaction");
      settingsRewrites.push({
        location: "settings.json: compaction.model",
        from: compactionModel,
        to: rewritten,
      });
    }
  }
  const overrideKeys = rewriteRecordKeys(
    settings.data.compaction?.modelOverrides as Record<string, unknown> | undefined,
    from,
    to,
  );
  if (overrideKeys.rewrites.length > 0) {
    patch.compaction = {
      ...settings.data.compaction,
      // 前面已经写进 patch.compaction 的 model 不能被原始设置覆盖回来。
      ...(patch.compaction as Record<string, unknown> | undefined),
      modelOverrides: overrideKeys.next,
    };
    for (const rewrite of overrideKeys.rewrites) {
      settingsRewrites.push({
        ...rewrite,
        location: `settings.json: compaction.modelOverrides ${rewrite.location}`,
      });
    }
  }
  const thinkingKeys = rewriteRecordKeys(
    settings.data.modelThinkingLevels as Record<string, unknown> | undefined,
    from,
    to,
  );
  if (thinkingKeys.rewrites.length > 0) {
    patch.modelThinkingLevels = thinkingKeys.next;
    replaceKeys.push("modelThinkingLevels");
    for (const rewrite of thinkingKeys.rewrites) {
      settingsRewrites.push({
        ...rewrite,
        location: `settings.json: modelThinkingLevels ${rewrite.location}`,
      });
    }
  }

  const presets = await args.settingsSource.listAgentPresets();
  const agents: NekProviderRenamePlan["agents"] = [];
  for (const preset of presets) {
    const model = preset.frontmatter.model;
    if (!model) continue;
    const rewritten = rewriteModelReference(model, from, to);
    if (!rewritten) continue;
    agents.push({
      name: preset.name,
      scope: preset.scope,
      path: preset.path,
      revision: preset.revision,
      rewrite: { location: `${preset.path}: model`, from: model, to: rewritten },
    });
  }

  return {
    from,
    to,
    models: {
      path: models.path,
      revision: models.revision,
      providerExists: Boolean(provider),
      modelCount: provider?.models?.length ?? 0,
    },
    settings: {
      path: settings.path,
      revision: settings.revision,
      patch,
      replaceKeys: [...new Set(replaceKeys)],
      rewrites: settingsRewrites,
    },
    agents,
    blockers,
  };
}

/** 执行改名：models.json 键改名 → settings 引用改写 → agents 预设引用改写。 */
export async function applyProviderRename(
  fs: NekConfigFs,
  service: NekConfigService,
  plan: NekProviderRenamePlan,
): Promise<{
  models: NekModelsDocument;
  settings: NekConfigDocument<unknown>;
  agents: NekAgentPresetDocument[];
}> {
  if (plan.blockers.length > 0)
    throw new Error(`cannot rename provider: ${plan.blockers.join("; ")}`);
  const models = await readModels(fs, plan.models.path);
  const provider = models.data.providers[plan.from];
  if (!provider) throw new Error(`provider "${plan.from}" disappeared`);
  if (!sameRevision(models.revision, plan.models.revision)) {
    throw new Error(`${plan.models.path} was modified externally; re-plan the rename`);
  }
  // 先写新键再删旧键：中途失败最多留下一个重复 provider，不会丢掉配置。
  const afterInsert = await upsertProvider(
    fs,
    plan.models.path,
    plan.to,
    provider,
    models.revision,
  );
  await removeProvider(fs, plan.models.path, plan.from, afterInsert.revision);

  let settings = await service.readSettings("global");
  if (Object.keys(plan.settings.patch).length > 0) {
    settings = await service.patchSettings(plan.settings.patch, {
      scope: "global",
      expectedRevision: plan.settings.revision,
      replaceKeys: plan.settings.replaceKeys,
    });
  }
  const agents: NekAgentPresetDocument[] = [];
  for (const agent of plan.agents) {
    const existing = await service.readAgentPreset(agent.name, agent.scope);
    if (!existing) throw new Error(`agent preset ${agent.path} disappeared`);
    // 正文必须原样写回：改的只是 frontmatter 里的 model 引用。
    const preset = await service.writeAgentPreset(
      {
        name: agent.name,
        frontmatter: { ...existing.frontmatter, model: agent.rewrite.to },
        body: existing.body,
      },
      { scope: agent.scope, expectedRevision: agent.revision },
    );
    agents.push(preset);
  }
  return { models: await readModels(fs, plan.models.path), settings, agents };
}
