export { validateNekProviderId as validateProviderId } from "@zcode/shared/nek-protocol";

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
