import type { NekSessionEntry } from "@zcode/shared/nek-protocol";
import { buildPlanPreviewRow, isPlanPreviewDetails, toEpochMs } from "./nekRows.js";

/** nek 的 TUI 预览仅是已保存计划的显示副本，不拥有对话行。 */
export const NEK_PLAN_PREVIEW = "nek.plan_preview";

export function nekPlanArtifactEntity(entryId: string): string {
  return `entry:${entryId}:plan`;
}

/** 与 nek 的 branch replay 同源：失败的工具结果和显示副本都不是计划版本。 */
export function projectNekPlanArtifact(
  entry: NekSessionEntry,
  turnId: string,
  allocate: (entityId: string) => number,
) {
  const result = entry.type === "message" ? entry.message : undefined;
  const details =
    entry.type === "custom" && entry.customType === "nek.plan_snapshot"
      ? entry.data
      : result?.role === "toolResult" &&
          !result.isError &&
          (result.toolName === "create_plan" || result.toolName === "update_plan")
        ? result.details
        : undefined;
  if (!isPlanPreviewDetails(details)) return;
  const entityId = nekPlanArtifactEntity(entry.id);
  return buildPlanPreviewRow(
    { entityId, rowId: allocate(entityId), turnId, createdAt: toEpochMs(entry.timestamp) },
    details,
  );
}
