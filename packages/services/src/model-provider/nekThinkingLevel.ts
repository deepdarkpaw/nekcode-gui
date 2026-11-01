/**
 * nek 的思考等级夹取规则。
 *
 * 与 nek `clampThinkingLevel`（`packages/ai/src/models.ts`）一致：精确命中就用它；否则先在
 * 规范顺序里向**上**找最近的受支持等级，再向**下**找，最后回到最低档。nek 未配置时用的默认
 * 等级是 `DEFAULT_THINKING_LEVEL = "medium"`（`core/defaults.ts`），由 settings.json 的
 * `effective.defaultThinkingLevel` 带过来（GUI 的设置默认值表也镜像了它），所以这里不另设常量。
 */
import { NEK_THINKING_LEVELS } from "@zcode/shared/nek-protocol";

export function clampNekThinkingLevel(
  levels: readonly string[],
  requested: string,
): string | undefined {
  if (levels.length === 0) return undefined;
  if (levels.includes(requested)) return requested;
  const requestedIndex = (NEK_THINKING_LEVELS as readonly string[]).indexOf(requested);
  if (requestedIndex === -1) return levels[0];
  for (let index = requestedIndex + 1; index < NEK_THINKING_LEVELS.length; index += 1) {
    const candidate = NEK_THINKING_LEVELS[index]!;
    if (levels.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = NEK_THINKING_LEVELS[index]!;
    if (levels.includes(candidate)) return candidate;
  }
  return levels[0];
}
