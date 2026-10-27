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
 */
import type {
  NekConfigTarget,
  NekCopyItemResult,
  NekCopyPreview,
  NekCopyResolution,
  NekCopyResult,
  NekCopySelection,
} from "@zcode/shared/nek-protocol";
import { editModelsSnapshot, readModelsSnapshot } from "./modelsDocument.js";
import { mcpPath, modelsPath, settingsPath } from "./paths.js";
import { patchSettingsDocument, readSettingsDocument } from "./settingsDocument.js";
import { readRawMcpServers, serializeMcpServers } from "./mcpDocument.js";
import { writeTextDocument } from "./documents.js";
import type { NekConfigRuntime } from "./runtime.js";
import { validationError } from "./errors.js";

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

/** 默认设置项：这些键跟着"默认模型"一起复制。 */
const DEFAULT_SETTING_KEYS = [
  "defaultProvider",
  "defaultModel",
  "defaultThinkingLevel",
  "enabledModels",
] as const;

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
    runtime.target(to);
    const targetModels = await modelsOf(to);
    const targetSettings = await settingsOf(to);
    const targetMcp = await mcpOf(to);
    const items: NekCopyPreview["items"] = [];
    for (const id of selection.providers) {
      items.push({
        kind: "provider",
        id,
        conflict: targetModels.snapshot.providers[id] !== undefined,
      });
    }
    if (selection.logins.length > 0) {
      const statuses = await runtime.login.authStatus(to);
      for (const id of selection.logins) {
        const status = statuses.find((entry) => entry.provider === id);
        items.push({ kind: "login", id, conflict: status?.kind === "oauth" });
      }
    }
    for (const id of selection.mcpServers) {
      items.push({ kind: "mcpServer", id, conflict: targetMcp.servers[id] !== undefined });
    }
    if (selection.defaults) {
      const raw = targetSettings.raw;
      const conflict =
        raw.defaultModel !== undefined ||
        raw.defaultProvider !== undefined ||
        raw.enabledModels !== undefined;
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
    for (const item of preview.items) {
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
          const target = await modelsOf(to);
          const revision = await editModelsSnapshot(
            target.context.executor,
            target.snapshot,
            target.snapshot.revision,
            [{ pointer: ["providers", item.id], value: source }],
          );
          written.push({ path: target.snapshot.path, revision });
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
          const patch: Record<string, unknown> = {};
          if (item.kind === "defaults") {
            for (const setting of DEFAULT_SETTING_KEYS) {
              if (sourceSettings.raw[setting] !== undefined) patch[setting] = sourceSettings.raw[setting];
            }
          } else if (sourceSettings.raw.compaction !== undefined) {
            patch.compaction = sourceSettings.raw.compaction;
          }
          if (Object.keys(patch).length === 0) {
            results.push({ key, status: "skipped", error: "the source has nothing to copy" });
            continue;
          }
          const targetSettings = await settingsOf(to);
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
    if (written.length > 0) runtime.publishWrite(to, written);
    return { items: results };
  };

  return { previewCopy, copy };
}
