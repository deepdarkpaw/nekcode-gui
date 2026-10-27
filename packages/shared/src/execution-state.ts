import { z } from "zod";

/** 接纳边界固定本次提交的模式：agent 直接执行，plan 只出方案。 */
export const executionPermissionModeSchema = z.enum(["agent", "plan"]);
export const executionStateSchema = z.object({
  mode: executionPermissionModeSchema,
  planEnabled: z.boolean(),
});
export type ExecutionState = z.infer<typeof executionStateSchema>;

/** 在接纳边界固定旧请求语义，不能在队列消费时按当前配置重新解释。 */
export function resolveExecutionState(
  input: { mode?: string; planEnabled?: boolean },
  current: ExecutionState = { mode: "agent", planEnabled: false },
): ExecutionState {
  const mode = executionPermissionModeSchema.safeParse(input.mode);
  return {
    mode: mode.success ? mode.data : current.mode,
    planEnabled:
      input.planEnabled ??
      (input.mode === "plan" ? true : mode.success ? false : current.planEnabled),
  };
}
