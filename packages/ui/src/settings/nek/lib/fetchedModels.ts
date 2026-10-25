/**
 * "获取模型列表"结果整理：新模型元数据的取值顺序
 * 1. 接口返回；2. nek 内置目录；3. nek 默认值（上下文 128000、最大输出 16384）。
 */
import type {
  NekCatalogModel,
  NekFetchModelsResult,
  NekModelConfig,
  NekRemoteModel,
  NekThinkingLevel,
} from "@zcode/shared/nek-protocol";
import { NEK_THINKING_LEVELS } from "@zcode/shared/nek-protocol";

export const NEK_DEFAULT_CONTEXT_WINDOW = 128_000;
export const NEK_DEFAULT_MAX_TOKENS = 16_384;

export type MetadataSource = "api" | "catalog" | "default";

export interface FetchedModelRow {
  id: string;
  name?: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevels: NekThinkingLevel[];
  input: Array<"text" | "image">;
  source: MetadataSource;
  alreadyAdded: boolean;
}

function hasApiMetadata(model: NekRemoteModel): boolean {
  return model.contextWindow !== undefined || model.maxTokens !== undefined;
}

function rowFromRemote(
  remote: NekRemoteModel,
  catalog: NekCatalogModel | undefined,
  alreadyAdded: boolean,
): FetchedModelRow {
  const source: MetadataSource = hasApiMetadata(remote) ? "api" : catalog ? "catalog" : "default";
  return {
    id: remote.id,
    name: remote.name ?? catalog?.name,
    contextWindow: remote.contextWindow ?? catalog?.contextWindow ?? NEK_DEFAULT_CONTEXT_WINDOW,
    maxTokens: remote.maxTokens ?? catalog?.maxTokens ?? NEK_DEFAULT_MAX_TOKENS,
    reasoning: remote.reasoning ?? catalog?.reasoning ?? false,
    thinkingLevels: remote.thinkingLevels ?? catalog?.thinkingLevels ?? [],
    input: remote.input ?? catalog?.input ?? ["text"],
    source,
    alreadyAdded,
  };
}

/** 合并接口结果与内置目录；按接口顺序，去重。 */
export function mergeFetchedModels(
  remote: readonly NekRemoteModel[],
  catalog: readonly NekCatalogModel[],
  existingIds: ReadonlySet<string>,
): FetchedModelRow[] {
  const catalogById = new Map(catalog.map((model) => [model.id, model]));
  const seen = new Set<string>();
  const rows: FetchedModelRow[] = [];
  for (const model of remote) {
    if (seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    rows.push(rowFromRemote(model, catalogById.get(model.id), existingIds.has(model.id)));
  }
  return rows;
}

/** 行 → models.json 模型配置；支持等级之外的写成 null。 */
export function modelConfigFromRow(row: FetchedModelRow): NekModelConfig {
  const config: NekModelConfig = {
    id: row.id,
    contextWindow: row.contextWindow,
    maxTokens: row.maxTokens,
    input: row.input,
  };
  if (row.name && row.name !== row.id) {
    config.name = row.name;
  }
  if (row.reasoning) {
    config.reasoning = true;
    if (row.thinkingLevels.length > 0) {
      const map: Partial<Record<NekThinkingLevel, string | null>> = {};
      for (const level of NEK_THINKING_LEVELS) {
        if (!row.thinkingLevels.includes(level)) {
          map[level] = null;
        }
      }
      if (Object.keys(map).length > 0) {
        config.thinkingLevelMap = map;
      }
    }
  }
  return config;
}

export type FetchErrorKind = "auth" | "notFound" | "other";

export function classifyFetchError(
  result: Extract<NekFetchModelsResult, { ok: false }>,
): FetchErrorKind {
  if (result.status === 401 || result.status === 403) {
    return "auth";
  }
  return result.status === 404 ? "notFound" : "other";
}

/** 搜索：ID 或名称包含关键字（不区分大小写）。 */
export function filterFetchedModels(
  rows: readonly FetchedModelRow[],
  query: string,
): FetchedModelRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return [...rows];
  }
  return rows.filter(
    (row) =>
      row.id.toLowerCase().includes(needle) || (row.name ?? "").toLowerCase().includes(needle),
  );
}
