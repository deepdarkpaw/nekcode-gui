import type { NekPlanReviewAction, NekStructuredUiResponse } from "@zcode/shared/nek-protocol";

export interface PlanReviewResult {
  action: NekPlanReviewAction;
}

export interface SwitchModeResult {
  approved: boolean;
}

const PLAN_REVIEW_ACTIONS: readonly NekPlanReviewAction[] = [
  "implement",
  "implement_fresh",
  "keep_planning",
  "exit",
];

export function isPlanReviewAction(value: unknown): value is NekPlanReviewAction {
  return typeof value === "string" && PLAN_REVIEW_ACTIONS.includes(value as NekPlanReviewAction);
}

export function buildPlanReviewResult(action: NekPlanReviewAction): PlanReviewResult {
  if (!isPlanReviewAction(action)) {
    throw new Error(`Unknown plan review action: ${String(action)}.`);
  }
  return { action };
}

export function buildSwitchModeResult(approved: boolean): SwitchModeResult {
  if (typeof approved !== "boolean") {
    throw new Error("Mode approval must be a boolean.");
  }
  return { approved };
}

export function buildStructuredResponse(id: string, result: unknown): NekStructuredUiResponse {
  return { type: "extension_ui_response", id, result };
}

export function buildCancelledStructuredResponse(id: string): NekStructuredUiResponse {
  return { type: "extension_ui_response", id, cancelled: true };
}
