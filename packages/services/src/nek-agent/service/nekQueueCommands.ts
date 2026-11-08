import type { NekStatusQueue } from "@zcode/shared/nek-protocol";
import type { NekAgentCommandContext } from "./nekAgentServiceCommands.js";

/** 取回与清空共用一次权威撤回；要求附件元数据随实际撤回内容一同返回。 */
export async function clearQueue(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<NekStatusQueue> {
  return await context
    .writableTarget(sessionKey)
    .client.call({ type: "clear_queue", includeAttachments: true });
}

export async function retrieveQueue(
  context: NekAgentCommandContext,
  sessionKey: string,
): Promise<NekStatusQueue> {
  return await clearQueue(context, sessionKey);
}

/** 按原 kind/顺序重投正文与原附件；失败明确中断，不能静默丢掉剩余输入。 */
export async function requeueQueue(
  context: NekAgentCommandContext,
  sessionKey: string,
  queue: NekStatusQueue,
): Promise<void> {
  const target = context.writableTarget(sessionKey);
  const hasFiles =
    queue.inputs &&
    [...queue.inputs.steering, ...queue.inputs.followUp].some((input) => input.attachments?.length);
  if (hasFiles && target.capabilities?.promptAttachments !== 1)
    throw new Error("当前 nek 不支持文件附件，请更新 nek；Remote SSH 会话需要更新远端 nek");
  for (const kind of ["steering", "followUp"] as const) {
    for (const [index, message] of queue[kind].entries()) {
      const attachments = queue.inputs?.[kind][index]?.attachments;
      await target.client.call({
        type: kind === "steering" ? "steer" : "follow_up",
        message,
        ...(attachments?.length
          ? {
              attachments: attachments.map(({ path, fileName, mimeType }) => ({
                path,
                fileName,
                mimeType,
              })),
            }
          : {}),
      });
    }
  }
}
