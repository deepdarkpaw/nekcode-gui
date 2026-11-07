/** Durable field deltas copy only their ancestor path; unrelated large arguments keep identity. */
export function appendToolArgument(
  input: unknown,
  path: readonly (string | number)[],
  delta: string,
): unknown {
  if (path.length === 0 || path.length > 64)
    throw new Error("Invalid nek tool argument delta path");
  const update = (value: unknown, depth: number): unknown => {
    if (!isContainer(value)) throw new Error("Invalid nek tool argument delta parent");
    const key = path[depth]!;
    if (
      Array.isArray(value) &&
      (typeof key !== "number" || !Number.isSafeInteger(key) || key < 0 || key > value.length)
    )
      throw new Error("Invalid nek tool argument delta array index");
    const own = Object.hasOwn(value, key);
    const current = own ? value[key] : undefined;
    const leaf = depth === path.length - 1;
    if (!leaf && !own) throw new Error("Missing nek tool argument delta parent");
    if (leaf && current !== undefined && typeof current !== "string")
      throw new Error("nek tool argument delta must append to a string");
    const nextValue = leaf ? (current ?? "") + delta : update(current, depth + 1);
    const next = Array.isArray(value) ? value.slice() : { ...value };
    // Define data properties: never invoke __proto__ setters or traverse inherited properties.
    Object.defineProperty(next, key, {
      value: nextValue,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return next;
  };
  return update(input ?? {}, 0);
}

function isContainer(value: unknown): value is Record<string | number, unknown> {
  return typeof value === "object" && value !== null;
}
