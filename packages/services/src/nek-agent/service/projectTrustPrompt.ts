/**
 * 项目信任确认：走 nek 的扩展 UI 通道（confirm dialog），不是 GUI 自创的通道。
 *
 * 渲染层用同一套 `NekInteractionHost` 卡片渲染这条 confirm；用户点确认后才由调用方
 * 通过 nek 的 `set_project_trust` 落盘（`<agentDir>/trust.json`，与 `/trust` 同一份），
 * 所以下一次不会再问。拒绝返回 `false`，由调用方抛出可重试的可见错误。
 */
import { randomUUID } from "node:crypto";
import type {
  NekExtensionUiDialogRequest,
  NekInteractionScope,
  NekProjectTrust,
} from "@zcode/shared/nek-protocol";
import type { NekRpcClient } from "../nekRpcClient.js";
import type { NekExtensionUiHandler } from "../nekExtensionUiRouter.js";
import type { NekTrustPrompt } from "./types.js";

/** 一个目录的信任状态：已记录决定就直接用，没记录才需要问。 */
export type NekProjectTrustDecision = "trusted" | "denied" | "ask";

export function projectTrustDecision(trust: NekProjectTrust): NekProjectTrustDecision {
  if (trust.trusted === true) return "trusted";
  if (trust.trusted === false) return "denied";
  if (trust.defaultProjectTrust === "always") return "trusted";
  if (trust.defaultProjectTrust === "never") return "denied";
  return "ask";
}

function trustDialogRequest(context: { cwd: string; trust: NekProjectTrust }): {
  request: NekExtensionUiDialogRequest;
  scope: NekInteractionScope;
} {
  const resources = context.trust.resources.map((resource) => resource.path);
  const detail =
    resources.length > 0
      ? `信任 ${context.cwd} 将允许 nek 加载项目设置、资源和扩展：\n${resources.join("\n")}`
      : `信任 ${context.cwd} 将允许 nek 加载项目设置、资源和扩展。`;
  return {
    scope: { workspacePath: context.cwd },
    request: {
      type: "extension_ui_request",
      id: `project-trust-${randomUUID()}`,
      method: "confirm",
      title: "是否信任此项目？",
      message: detail,
    },
  };
}

/**
 * 生产默认实现：把确认请求交给渲染层。
 *
 * `handlerFor` 按范围给出扩展 UI 处理器（生产是交互桥，测试可注入）。
 */
export function createProjectTrustPrompt(
  handlerFor: (scope: NekInteractionScope) => NekExtensionUiHandler | undefined,
): NekTrustPrompt {
  return async (context) => {
    const { request, scope } = trustDialogRequest(context);
    const handler = handlerFor(scope);
    if (!handler?.dialog) {
      throw new Error(
        `project trust decision required for ${context.cwd}, but no GUI interaction channel is attached`,
      );
    }
    const answer = await handler.dialog(request, context.signal ?? new AbortController().signal);
    return answer !== undefined && "confirmed" in answer && answer.confirmed === true;
  };
}

/**
 * 向控制进程取信任状态，必要时问渲染层，确认后立刻按 nek 的规则落盘。
 *
 * 已记录的决定（含 `defaultProjectTrust: always/never`）不询问；拒绝直接抛错，
 * 错误信息包含"确认信任后重试"，调用方可以原样重试。
 */
export async function resolveProjectTrustApproval(options: {
  client: NekRpcClient;
  askProjectTrust: NekTrustPrompt;
  cwd: string;
}): Promise<boolean> {
  const { cwd } = options;
  const trust = await options.client.call({ type: "get_project_trust", cwd });
  const decision = projectTrustDecision(trust);
  if (decision !== "ask") return decision === "trusted";
  const approved = await options.askProjectTrust({ trust, cwd });
  if (!approved) throw new Error(`project trust denied for ${cwd}; confirm trust and retry`);
  await options.client.call({ type: "set_project_trust", cwd, trusted: true });
  return true;
}
