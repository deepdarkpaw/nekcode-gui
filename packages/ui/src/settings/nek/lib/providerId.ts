/**
 * 服务商 ID（models.json 的键）：`[a-z0-9-]+`，唯一；新建时由名称生成。
 */

export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type ProviderIdError = "required" | "format" | "duplicate";

/** 由显示名称生成 ID；无法生成（例如纯中文名称）时返回空串，由用户手填。 */
export function slugifyProviderId(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function validateProviderId(
  id: string,
  existingIds: ReadonlySet<string>,
): ProviderIdError | null {
  if (id === "") {
    return "required";
  }
  if (!PROVIDER_ID_PATTERN.test(id)) {
    return "format";
  }
  return existingIds.has(id) ? "duplicate" : null;
}
