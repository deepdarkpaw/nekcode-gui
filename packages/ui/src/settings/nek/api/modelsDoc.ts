/**
 * models.json 文档 hook：服务商与模型的增删改、排序、改 ID，全部乐观更新、失败回滚。
 */
import { useCallback, useMemo } from "react";
import type {
  NekModelConfig,
  NekModelsConfigView,
  NekProviderView,
  NekProviderWrite,
} from "@zcode/shared/nek-protocol";
import { useNekSettingsContext } from "./NekSettingsContext.js";
import { useNekDocument, type NekDocument } from "./useNekDocument.js";

/** 字面量密钥的展示掩码：只保留末 4 位。 */
export function maskApiKey(key: string): string {
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}

/** 写入值 → 读取视图里的 apiKey 描述（乐观更新用）。 */
export function apiKeyViewFromWrite(
  apiKey: NekProviderWrite["apiKey"],
  previous: NekProviderView["apiKey"] | undefined,
): NekProviderView["apiKey"] {
  if (apiKey === undefined) {
    return { kind: "none" };
  }
  if (typeof apiKey !== "string") {
    return "remove" in apiKey ? { kind: "none" } : (previous ?? { kind: "none" });
  }
  const env = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(apiKey);
  if (env) {
    return { kind: "env", name: env[1] ?? "" };
  }
  if (apiKey.startsWith("!")) {
    return { kind: "command", command: apiKey.slice(1) };
  }
  return { kind: "literal", masked: maskApiKey(apiKey) };
}

function providerViewFromWrite(
  write: NekProviderWrite,
  previous?: NekProviderView,
): NekProviderView {
  const { apiKey, ...rest } = write;
  return {
    ...rest,
    // 与 host 读取视图一致：没在服务商上设置端点时为空串。
    api: rest.api ?? "",
    apiKey: apiKeyViewFromWrite(apiKey, previous?.apiKey),
    overridesBuiltin: previous?.overridesBuiltin ?? false,
  };
}

function mapProvider(
  data: NekModelsConfigView,
  providerId: string,
  update: (provider: NekProviderView) => NekProviderView,
): NekModelsConfigView {
  return {
    ...data,
    providers: data.providers.map((provider) =>
      provider.id === providerId ? update(provider) : provider,
    ),
  };
}

function orderModels(models: readonly NekModelConfig[], ids: readonly string[]): NekModelConfig[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const ordered = ids.flatMap((id) => {
    const model = byId.get(id);
    return model ? [model] : [];
  });
  const rest = models.filter((model) => !ids.includes(model.id));
  return [...ordered, ...rest];
}

export interface NekModelsDocument extends NekDocument<NekModelsConfigView> {
  saveProvider: (provider: NekProviderWrite, isNew: boolean) => Promise<void>;
  deleteProvider: (providerId: string) => Promise<void>;
  renameProvider: (from: string, to: string) => Promise<void>;
  saveModel: (providerId: string, model: NekModelConfig, previousId?: string) => Promise<void>;
  addModels: (providerId: string, models: NekModelConfig[]) => Promise<void>;
  deleteModel: (providerId: string, modelId: string) => Promise<void>;
  reorderModels: (providerId: string, modelIds: string[]) => Promise<void>;
}

export function useNekModelsDoc(): NekModelsDocument {
  const { config, target, projectCwd } = useNekSettingsContext();
  const doc = useNekDocument<NekModelsConfigView>({
    // 带 cwd：服务商被哪些用户 / 项目预设引用要看项目目录下的 `agents/*.md`。
    load: (api, current) => api.readModelsConfig(current, projectCwd),
    deps: [projectCwd],
  });
  const { mutate } = doc;

  const saveProvider = useCallback(
    (provider: NekProviderWrite, isNew: boolean) =>
      mutate({
        optimistic: (data) => {
          const previous = data.providers.find((item) => item.id === provider.id);
          const view = providerViewFromWrite(provider, previous);
          return previous
            ? mapProvider(data, provider.id, () => view)
            : { ...data, providers: [...data.providers, view] };
        },
        write: (data) => config.saveProvider(target, provider, { revision: data.revision, isNew }),
      }),
    [config, target, mutate],
  );

  const deleteProvider = useCallback(
    (providerId: string) =>
      mutate({
        optimistic: (data) => ({
          ...data,
          providers: data.providers.filter((provider) => provider.id !== providerId),
        }),
        write: (data) => config.deleteProvider(target, providerId, { revision: data.revision }),
      }),
    [config, target, mutate],
  );

  const renameProvider = useCallback(
    (from: string, to: string) =>
      mutate({
        optimistic: (data) => mapProvider(data, from, (provider) => ({ ...provider, id: to })),
        write: (data) =>
          config.renameProvider(target, from, to, { revision: data.revision, cwd: projectCwd }),
      }),
    [config, target, projectCwd, mutate],
  );

  const saveModel = useCallback(
    (providerId: string, model: NekModelConfig, previousId?: string) =>
      mutate({
        optimistic: (data) =>
          mapProvider(data, providerId, (provider) => {
            const key = previousId ?? model.id;
            const exists = provider.models.some((item) => item.id === key);
            return {
              ...provider,
              models: exists
                ? provider.models.map((item) => (item.id === key ? model : item))
                : [...provider.models, model],
            };
          }),
        write: (data) =>
          config.saveModel(target, providerId, model, { revision: data.revision, previousId }),
      }),
    [config, target, mutate],
  );

  const addModels = useCallback(
    (providerId: string, models: NekModelConfig[]) =>
      mutate({
        optimistic: (data) =>
          mapProvider(data, providerId, (provider) => ({
            ...provider,
            models: [...provider.models, ...models],
          })),
        write: (data) => config.addModels(target, providerId, models, { revision: data.revision }),
      }),
    [config, target, mutate],
  );

  const deleteModel = useCallback(
    (providerId: string, modelId: string) =>
      mutate({
        optimistic: (data) =>
          mapProvider(data, providerId, (provider) => ({
            ...provider,
            models: provider.models.filter((model) => model.id !== modelId),
          })),
        write: (data) =>
          config.deleteModel(target, providerId, modelId, { revision: data.revision }),
      }),
    [config, target, mutate],
  );

  const reorderModels = useCallback(
    (providerId: string, modelIds: string[]) =>
      mutate({
        optimistic: (data) =>
          mapProvider(data, providerId, (provider) => ({
            ...provider,
            models: orderModels(provider.models, modelIds),
          })),
        write: (data) =>
          config.reorderModels(target, providerId, modelIds, { revision: data.revision }),
      }),
    [config, target, mutate],
  );

  return useMemo(
    () => ({
      ...doc,
      saveProvider,
      deleteProvider,
      renameProvider,
      saveModel,
      addModels,
      deleteModel,
      reorderModels,
    }),
    [
      doc,
      saveProvider,
      deleteProvider,
      renameProvider,
      saveModel,
      addModels,
      deleteModel,
      reorderModels,
    ],
  );
}
