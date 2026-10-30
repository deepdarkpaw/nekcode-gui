import { randomUUID } from "node:crypto";
import type { NekExtensionUiDialogRequest } from "@zcode/shared/nek-protocol";
import type { NekExtensionUiHandler } from "../nekExtensionUiRouter.js";
import type { NekTrustPrompt } from "./types.js";

/** Creates the startup trust confirmation on the existing extension UI channel. */
export function createProjectTrustPrompt(
  handler: NekExtensionUiHandler | undefined,
): NekTrustPrompt | undefined {
  const dialog = handler?.dialog;
  if (!dialog) return undefined;
  return async ({ cwd, signal }) => {
    const request: NekExtensionUiDialogRequest = {
      type: "extension_ui_request",
      id: `project-trust-${randomUUID()}`,
      method: "confirm",
      title: "是否信任此项目？",
      message: `信任 ${cwd} 将允许 nek 加载项目设置、资源和扩展。`,
    };
    const answer = await dialog(request, signal ?? new AbortController().signal);
    return answer !== undefined && "confirmed" in answer ? answer.confirmed : false;
  };
}
