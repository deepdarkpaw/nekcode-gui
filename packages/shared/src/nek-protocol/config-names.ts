/** nek v0.5.1: core/model-config.ts, core/model-runtime.ts, core/model-resolver.ts. */
export type NekProviderIdError = "required" | "slash" | "edgeWhitespace" | "duplicate";

/** Check a new ID without rewriting it. Exact config keys and the reference prefix differ:
 * nek lowercases both sides of a `provider/model` lookup, but trims only the typed prefix.
 */
export function validateNekProviderId(
  id: unknown,
  existingIds: Iterable<string>,
  previousId?: string,
): NekProviderIdError | null {
  if (typeof id !== "string" || !id.trim()) return "required";
  if (id.includes("/")) return "slash";
  if (id !== id.trim()) return "edgeWhitespace";
  const prefix = id.toLowerCase();
  for (const existing of existingIds) {
    if (existing !== previousId && existing.toLowerCase() === prefix) return "duplicate";
  }
  return null;
}
