import type { ConversationOpenTiming } from "@zcode/shared/zcode-protocol-v4";

/** 同一进程内的单调时钟跨度；技术计时不进入会话事实或持久缓存。 */
export function nekOpenDurationMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

/** 进程池就绪的跨度与资源身份；不由 pid 缺省值猜测是否新建了进程。 */
export async function measureNekOpenBootstrap<T>(
  timing: ConversationOpenTiming | undefined,
  previous: T | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const process = await run();
  if (timing) {
    timing.cliBootstrapMs = (timing.cliBootstrapMs ?? 0) + nekOpenDurationMs(startedAt);
    timing.cliProcessState = previous === process ? "reused" : "spawned";
  }
  return process;
}

/** 并行快照 RPC 以一段等待跨度计量，不把重叠请求的耗时相加。 */
export async function measureNekOpenRequest<T>(
  timing: ConversationOpenTiming | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    if (timing) timing.cliRequestMs = (timing.cliRequestMs ?? 0) + nekOpenDurationMs(startedAt);
  }
}
