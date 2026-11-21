import { useEffect, useMemo } from "react";
import type { NekCatalogModel, NekModelScopeResult } from "@zcode/shared/nek-protocol";
import { useAsyncAction } from "@/hooks/useAsyncAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatModelRef } from "../lib/modelRef.js";
import { useNekSettingsContext } from "./NekSettingsContext.js";
import { isNekConflictError } from "./nekErrors.js";
import { useModelScopeCwd } from "./useModelScopeCwd.js";
import { useNekQuery } from "./useNekQuery.js";

interface ScopeRead {
  key: string;
  available: NekCatalogModel[];
  scope: NekModelScopeResult;
}

/** 两个设置入口共享同一份 CLI 匹配结果、提交语义和保存反馈。 */
export function useCliModelScope() {
  const { intl } = useZCodeIntl();
  const { config, target, targetKey, subscribeChanges } = useNekSettingsContext();
  const cwd = useModelScopeCwd();
  const key = JSON.stringify([targetKey, cwd]);
  const read = useNekQuery<ScopeRead>(
    async (api, current) => {
      const [available, scope] = await Promise.all([
        api.listAvailableModels(current),
        api.getModelScope(current, cwd),
      ]);
      const refs = new Set(available.map(({ provider, id }) => formatModelRef(provider, id)));
      if (scope.models.some(({ provider, id }) => !refs.has(formatModelRef(provider, id)))) {
        throw new Error(intl.formatMessage({ id: "settings.nek.scoped.readConflict" }));
      }
      return { key, available, scope };
    },
    [cwd],
    { refreshOnWrite: false },
  );
  const { reload } = read;
  const query =
    read.data && read.data.key !== key
      ? { status: "loading" as const, data: undefined, error: undefined, reload }
      : read;
  useEffect(() => {
    return subscribeChanges(({ file, scope }) => {
      if (scope === "project" && !cwd) return;
      const name = file.replaceAll("\\", "/").split("/").at(-1);
      if (name && ["models.json", "settings.json", "auth.json", "trust.json"].includes(name))
        void reload();
    });
  }, [cwd, reload, subscribeChanges]);
  const data = query.status === "ready" ? query.data : undefined;
  const members = data?.scope.models.length ? data.scope.models : data?.available;
  const membership = useMemo(() => {
    const available = new Set(
      data?.available.map(({ provider, id }) => formatModelRef(provider, id)),
    );
    const included =
      members === data?.available
        ? available
        : new Set(members?.map(({ provider, id }) => formatModelRef(provider, id)));
    return { available, included };
  }, [data, members]);
  const save = useAsyncAction(async (patterns: string[]) => {
    if (!data) throw new Error(intl.formatMessage({ id: "settings.nek.error.notLoaded" }));
    try {
      await config.saveModelScope(target, patterns, { cwd, expectedPatterns: data.scope.patterns });
    } catch (error) {
      if (isNekConflictError(error)) await reload();
      throw error;
    }
    await reload();
  });
  const toggle = (refs: readonly string[], checked: boolean) => {
    if (!data || !members) return;
    if (checked) {
      void save.run([
        ...data.scope.patterns,
        ...refs.filter((ref) => !membership.included.has(ref)),
      ]);
      return;
    }
    const removed = new Set(refs);
    // 即使某项来自通配符，也能只排除指定模型；保留原生顺序和显式思考档位。
    const remaining = members.flatMap(({ provider, id, ...model }) => {
      const ref = formatModelRef(provider, id);
      if (removed.has(ref)) return [];
      return [
        "thinkingLevel" in model && model.thinkingLevel ? `${ref}:${model.thinkingLevel}` : ref,
      ];
    });
    if (remaining.length) void save.run(remaining);
  };
  return { query, data, membership, save, toggle };
}

export type CliModelScopeEditor = ReturnType<typeof useCliModelScope>;
