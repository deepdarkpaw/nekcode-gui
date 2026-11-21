import type { NekRpcClient } from "../nekRpcClient.js";
import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import { readyNekPlan } from "../projection/nekProjectionSnapshot.js";
import { isNekState } from "./types.js";

export type NekPlanExecution = CommandPayloadMap["executeNekPlan"];

function planId(path: string): string {
  const file = path.replaceAll("\\", "/").split("/").at(-1) ?? "";
  return file.endsWith(".plan.md") ? file.slice(0, -".plan.md".length) : file;
}

export async function readNekPlanState(client: NekRpcClient) {
  const { result } = await client.call({ type: "extension_call", method: "nek.get_state" });
  if (!isNekState(result)) throw new Error("nek 未返回有效的会话计划状态");
  return result;
}

/**
 * 同一进程最后一次校验必须与可见卡片的路径、修订完全匹配；`--revision` 让 nek 在执行前
 * 再按当前分支的修订原子拒绝，覆盖本地校验与命令执行之间计划又被修订的窗口。
 */
export function buildNekPlanCommand(
  state: Awaited<ReturnType<typeof readNekPlanState>>,
  input: NekPlanExecution,
): string {
  const active = readyNekPlan(state);
  if (active?.path !== input.path || active.revision !== input.revision)
    throw new Error("此修订已不是当前可执行的计划，请打开最新计划");
  const id = planId(active.path);
  // CLI 按第一个 filename id 匹配，不能在目录设置变化导致重名时提交另一份计划；
  // 以 `-` 开头的 id 会被 nek 当作选项拒绝。
  if (
    !id ||
    /\s|^-/u.test(id) ||
    state.plans.find((plan) => planId(plan.path) === id)?.path !== active.path
  )
    throw new Error("nek 计划 ID 无法唯一定位当前计划");
  return `/nek-build ${id} --revision ${active.revision}${input.fresh ? " --fresh" : ""}`;
}

/** fresh 的 prompt ACK 在整个子会话首轮之后才回；接纳边界是子会话首条持久用户输入。 */
export async function submitFreshNekPlan(
  client: NekRpcClient,
  message: string,
  expect: (started: () => void) => () => void,
  drain: () => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  let release: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    release = expect(resolve);
  });
  try {
    const ack = client.call({ type: "prompt", message }, { signal: controller.signal });
    await Promise.race([
      started,
      ack.then(async () => {
        await drain();
        throw new Error("nek 没有在新会话开始执行计划，请查看会话提示");
      }),
    ]);
  } finally {
    release();
    // 只结束本地 RPC 等待；不向已经开始执行的子会话发 abort。
    controller.abort();
  }
}
