/** 设置页技能 / 命令列表的关键字过滤：空关键字全部命中，其余按小写包含匹配任一字段。 */
export function matchesCapabilityQuery(
  query: string,
  values: readonly (string | undefined)[],
): boolean {
  const keyword = query.trim().toLowerCase();
  if (!keyword) return true;
  return values.some((value) => value?.toLowerCase().includes(keyword));
}
