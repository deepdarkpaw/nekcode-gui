/**
 * 从一台目标复制配置到另一台（通常是"本机 → 远程主机"）。
 *
 * 冲突处理：调用方先 `previewCopy`，再按项给出 `overwrite` / `skip`（键是 `<kind>:<id>`）。
 * 没有给出决议的冲突项一律跳过 —— "覆盖"必须由用户显式选择。
 *
 * 逐项结果：`copy` 不再中途抛错，而是返回 `{items:[{key,status,error?}]}`，
 * 让界面能显示"哪一项成功、哪一项失败、为什么失败"，失败项可以单独重试。
 *
 * OAuth 登录不写 `auth.json`：契约要求只能经 `auth_*` RPC。所以登录项是在**目标机器**上
 * 重新发起一次 OAuth；如果那台机器需要用户在浏览器里点确认或粘贴授权码，这一项会以
 * `status: "failed"` 返回，提示用户去目标机器单独登录（刷新令牌不搬家，避免两台机器互相踢下线）。
 *
 * 跨平台：值原样搬运，不改写；预览对依赖源机器环境的值（环境变量、`!命令`、Windows 路径）
 * 给出提示（见 `copyPortability.ts`）。
 */
import type {
  NekConfigTarget,
  NekCopyItemResult,
  NekCopyPreview,
  NekCopyResolution,
  NekCopyResult,
  NekCopySelection,
  NekCopyWarning,
} from "@zcode/shared/nek-protocol";
import { isPlainObject } from "../nek-agent/config/nekConfigDocuments.js";
import { readModelsSnapshot } from "./modelsDocument.js";
import { writeModelsAndScope } from "./modelScopeWrite.js";
import { mcpPath, modelsPath, settingsPath } from "./paths.js";
import { patchSettingsDocument, readSettingsDocument } from "./settingsDocument.js";
import { readRawMcpServers, serializeMcpServers } from "./mcpDocument.js";
import { writeTextDocument } from "./documents.js";
import type { NekConfigRuntime } from "./runtime.js";
import { validationError } from "./errors.js";
import { mcpServerCopyWarnings, providerCopyWarnings } from "./copyPortability.js";

export interface NekCopyGroup {
  previewCopy: (
    from: NekConfigTarget,
    to: NekConfigTarget,
    selection: NekCopySelection,
  ) => Promise<NekCopyPreview>;
  copy: (
    from: NekConfigTarget,
    to: NekConfigTarget,
    selection: NekCopySelection,
    resolution: NekCopyResolution,
  ) => Promise<NekCopyResult>;
}

/** 与 `NekCopyResolution` 的键格式一致。 */
export function copyItemKey(kind: NekCopyPreview["items"][number]["kind"], id: string): string {
  return `${kind}:${id}`;
}

/**
 * "默认模型与循环范围"：这些键作为一组复制，复制后目标与源一致。源没有 `enabledModels`
 * 表示不限范围（显示全部模型），目标上残留的旧范围必须一起删掉，否则新复制的模型在目标上被隐藏。
 */
const DEFAULT_SETTING_KEYS = [
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "enabledModels",
] as const;

/**
 * settings 补丁：合并后目标值与源值一致。补丁按嵌套对象逐键合并、`null` 删除，
 * 所以目标多出的键要显式删；源没有而目标有时整键删除。返回 `undefined` 表示两边都没有。
 */
function mirrorPatch(source: unknown, target: unknown): unknown {
  if (source === undefined) return target === undefined ? undefined : null;
  if (!isPlainObject(source) || !isPlainObject(target)) return source;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) patch[key] = mirrorPatch(value, target[key]);
  for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) patch[key] = null;
  return patch;
}

function mirrorSettings(
  keys: readonly string[],
  source: Record<string, unknown>,
  target: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    const value = mirrorPatch(source[key], target[key]);
    if (value !== undefined) patch[key] = value;
  }
  return patch;
}

/**
 * 服务商的模型默认思考档位（`modelThinkingLevels` 里 `<provider>/` 开头的键）跟着服务商复制：
 * 模型编辑器把它当作模型属性展示，只搬 models.json 会让目标上的档位丢失或残留旧值。
 */
function providerThinkingLevelsPatch(
  source: unknown,
  target: unknown,
  providerId: string,
): Record<string, unknown> {
  const prefix = `${providerId}/`;
  const entriesOf = (levels: unknown) =>
    Object.entries(isPlainObject(levels) ? levels : {}).filter(([ref]) => ref.startsWith(prefix));
  const wanted = Object.fromEntries(entriesOf(source));
  const current = Object.fromEntries(entriesOf(target));
  const patch: Record<string, unknown> = {};
  for (const [ref, level] of Object.entries(wanted)) if (current[ref] !== level) patch[ref] = level;
  for (const ref of Object.keys(current)) if (!Object.hasOwn(wanted, ref)) patch[ref] = null;
  if (Object.keys(patch).length === 0) return {};
  const others = Object.keys(isPlainObject(target) ? target : {}).filter(
    (ref) => !ref.startsWith(prefix),
  );
  const empty = others.length === 0 && Object.keys(wanted).length === 0;
  return { modelThinkingLevels: empty ? null : patch };
}

function withWarnings(
  item: NekCopyPreview["items"][number],
  warnings: NekCopyWarning[],
): NekCopyPreview["items"][number] {
  return warnings.length > 0 ? { ...item, warnings } : item;
}

export function createCopyGroup(runtime: NekConfigRuntime): NekCopyGroup {
  const modelsOf = async (target: NekConfigTarget) => {
    const context = runtime.target(target);
    return {
      context,
      snapshot: await readModelsSnapshot(context.executor, modelsPath(context.layout)),
    };
  };

  const settingsOf = async (target: NekConfigTarget) => {
    const context = runtime.target(target);
    return await readSettingsDocument(context.executor, settingsPath(context.layout, "global"));
  };

  const mcpOf = async (target: NekConfigTarget) => {
    const context = runtime.target(target);
    const path = mcpPath(context.layout, "global");
    return { context, path, servers: await readRawMcpServers(context.executor, path) };
  };

  const previewCopy: NekCopyGroup["previewCopy"] = async (from, to, selection) => {
    runtime.target(from);
    const targetPlatform = runtime.target(to).executor.platform();
    const targetModels = await modelsOf(to);
    const targetSettings = await settingsOf(to);
    const targetMcp = await mcpOf(to);
    const sourceProviders =
      selection.providers.length > 0 ? (await modelsOf(from)).snapshot.providers : {};
    const sourceMcp = selection.mcpServers.length > 0 ? (await mcpOf(from)).servers : {};
    const items: NekCopyPreview["items"] = [];
    for (const id of selection.providers) {
      const source = sourceProviders[id];
      items.push(
        withWarnings(
          { kind: "provider", id, conflict: targetModels.snapshot.providers[id] !== undefined },
          source ? providerCopyWarnings(source) : [],
        ),
      );
    }
    if (selection.logins.length > 0) {
      const statuses = await runtime.login.authStatus(to);
      for (const id of selection.logins) {
        const status = statuses.find((entry) => entry.provider === id);
        items.push({ kind: "login", id, conflict: status?.kind === "oauth" });
      }
    }
    for (const id of selection.mcpServers) {
      const source = sourceMcp[id];
      items.push(
        withWarnings(
          { kind: "mcpServer", id, conflict: targetMcp.servers[id] !== undefined },
          source ? mcpServerCopyWarnings(source, targetPlatform) : [],
        ),
      );
    }
    if (selection.defaults) {
      const raw = targetSettings.raw;
      const conflict = DEFAULT_SETTING_KEYS.some((key) => raw[key] !== undefined);
      items.push({ kind: "defaults", id: "defaults", conflict });
    }
    if (selection.compaction) {
      items.push({
        kind: "compaction",
        id: "compaction",
        conflict: targetSettings.raw.compaction !== undefined,
      });
    }
    return { items };
  };

  const copy: NekCopyGroup["copy"] = async (from, to, selection, resolution) => {
    if (from.kind === to.kind && from.kind === "local") {
      throw validationError("source and destination are the same target", { to: "same target" });
    }
    if (from.kind === "remote" && to.kind === "remote" && from.connectionId === to.connectionId) {
      throw validationError("source and destination are the same target", { to: "same target" });
    }
    const preview = await previewCopy(from, to, selection);
    const results: NekCopyItemResult[] = [];
    const written: Array<{ path: string; revision: string }> = [];
    const defaults = preview.items.find((item) => item.kind === "defaults");
    const copyDefaults =
      defaults && (!defaults.conflict || resolution["defaults:defaults"] === "overwrite");
    // 同时覆盖全局默认设置时先应用它；随后复制服务商只改写目标范围里已失效的引用，不追加新模型。
    const items = copyDefaults
      ? [defaults, ...preview.items.filter((item) => item !== defaults)]
      : preview.items;
    for (const item of items) {
      const key = copyItemKey(item.kind, item.id);
      if (item.conflict && resolution[key] !== "overwrite") {
        results.push({ key, status: "skipped" });
        continue;
      }
      try {
        if (item.kind === "provider") {
          const source = (await modelsOf(from)).snapshot.providers[item.id];
          if (!source)
            throw validationError(`provider "${item.id}" no longer exists on the source`, {
              id: "missing",
            });
          const sourceLevels = (await settingsOf(from)).raw.modelThinkingLevels;
          const target = await modelsOf(to);
          const saved = await writeModelsAndScope(
            runtime,
            to,
            target.snapshot,
            [{ pointer: ["providers", item.id], value: source }],
            {
              revision: target.snapshot.revision,
              cwd: selection.targetCwd,
              globalSettings: {
                patch: (document) =>
                  providerThinkingLevelsPatch(
                    sourceLevels,
                    document.raw.modelThinkingLevels,
                    item.id,
                  ),
              },
            },
          );
          written.push(...saved.written);
        } else if (item.kind === "mcpServer") {
          const source = await mcpOf(from);
          const target = await mcpOf(to);
          const config = source.servers[item.id];
          if (!config)
            throw validationError(`MCP server "${item.id}" no longer exists on the source`, {
              id: "missing",
            });
          const revision = await writeTextDocument(
            target.context.executor,
            target.path,
            serializeMcpServers({ ...target.servers, [item.id]: config }),
          );
          written.push({ path: target.path, revision });
        } else if (item.kind === "defaults" || item.kind === "compaction") {
          const sourceSettings = await settingsOf(from);
          const targetSettings = await settingsOf(to);
          const patch = mirrorSettings(
            item.kind === "defaults" ? DEFAULT_SETTING_KEYS : ["compaction"],
            sourceSettings.raw,
            targetSettings.raw,
          );
          if (Object.keys(patch).length === 0) {
            results.push({ key, status: "skipped", error: "the source has nothing to copy" });
            continue;
          }
          const target = runtime.target(to);
          written.push(
            await patchSettingsDocument({
              executor: target.executor,
              path: settingsPath(target.layout, "global"),
              patch,
              expectedRevision: targetSettings.revision,
            }),
          );
        } else {
          await runtime.login.runToCompletion(to, item.id);
        }
        results.push({ key, status: "copied" });
      } catch (error) {
        results.push({
          key,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Login-only copies publish through runToCompletion's successful auth_login path.
    if (written.length > 0) await runtime.publishWrite(to, written);
    return { items: results };
  };

  return { previewCopy, copy };
}
