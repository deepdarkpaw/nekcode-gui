/** Durable 的字段 delta 不含 JSON 引号/括号；只更新指定字符串，不能拼到 inputText 末尾。 */
export function appendToolArgument(
  input: unknown,
  path: readonly (string | number)[],
  delta: string,
): unknown {
  if (path.length === 0 || path.length > 64)
    throw new Error("Invalid nek tool argument delta path");
  const next = structuredClone(input ?? {});
  let target: unknown = next;
  for (const segment of path.slice(0, -1)) {
    if (!isContainer(target) || !Object.hasOwn(target, segment))
      throw new Error("Missing nek tool argument delta parent");
    target = target[segment];
  }
  if (!isContainer(target)) throw new Error("Invalid nek tool argument delta parent");
  const key = path[path.length - 1]!;
  if (
    Array.isArray(target) &&
    (typeof key !== "number" || !Number.isSafeInteger(key) || key < 0 || key > target.length)
  )
    throw new Error("Invalid nek tool argument delta array index");
  const current = Object.hasOwn(target, key) ? target[key] : undefined;
  if (current !== undefined && typeof current !== "string")
    throw new Error("nek tool argument delta must append to a string");
  // 定义自有数据属性，不经 __proto__ setter，也不沿原型查找路径。
  Object.defineProperty(target, key, {
    value: (current ?? "") + delta,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return next;
}

function isContainer(value: unknown): value is Record<string | number, unknown> {
  return typeof value === "object" && value !== null;
}
