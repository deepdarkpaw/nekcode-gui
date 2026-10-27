/**
 * `defaultTools`：nek 支持上游的 `+name / -name` 写法（相对默认工具集增减）。
 * GUI 一律写成增减形式，关闭联网写 `-web_search`，不把默认工具列表冻结住。
 *
 * 工具清单不在这里硬编码：`listBuiltinTools` 从 host 取（nek 没有对应 RPC 时由 host 维护镜像），
 * 见 `packages/services/src/nek-config-api/builtinTools.ts`。
 */

export const WEB_SEARCH_TOOL = "web_search";

function isDelta(entry: string): boolean {
  return entry.startsWith("+") || entry.startsWith("-");
}

/** 由设置值与默认工具集算出生效的工具集合。 */
export function resolveEnabledTools(
  setting: readonly string[] | undefined,
  defaults: readonly string[],
): Set<string> {
  if (!setting) {
    return new Set(defaults);
  }
  const absolute = setting.filter((entry) => !isDelta(entry));
  // 只有增减项时以默认集为基础；含绝对项时以绝对项为基础。
  const enabled = new Set(absolute.length > 0 ? absolute : defaults);
  for (const entry of setting.filter(isDelta)) {
    const name = entry.slice(1);
    if (entry.startsWith("+")) {
      enabled.add(name);
    } else {
      enabled.delete(name);
    }
  }
  return enabled;
}

/** 生效集合 → 增减写法；与默认集相同时返回 null（删除该键）。 */
export function buildDefaultToolsSetting(
  enabled: ReadonlySet<string>,
  defaults: readonly string[],
  knownTools: readonly string[],
): string[] | null {
  const order = [...new Set([...knownTools, ...defaults, ...enabled])];
  const defaultSet = new Set(defaults);
  const entries: string[] = [];
  for (const name of order) {
    if (enabled.has(name) && !defaultSet.has(name)) {
      entries.push(`+${name}`);
    } else if (!enabled.has(name) && defaultSet.has(name)) {
      entries.push(`-${name}`);
    }
  }
  return entries.length > 0 ? entries : null;
}
