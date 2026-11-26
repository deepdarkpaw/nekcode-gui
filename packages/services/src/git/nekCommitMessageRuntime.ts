import type { AppSettings, ZCodeWorkspaceGenerateTextParams } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/shared/model-selection-resolution";
import { DEFAULT_GUI_RUNTIME_CONFIG } from "@zcode/shared/guiRuntimeConfig";
import { NekLocator } from "../nek-agent/nekLocator.js";
import { createNekRpcProcess, type NekRpcProcess } from "../nek-agent/nekRpcProcess.js";

type Selection = ZCodeWorkspaceGenerateTextParams["selection"];

/** A missing explicit choice never sends project data to a different model. */
export function selectGitMessageModel(
  view: ModelSelectionView,
  override: AppSettings["gitCommitMessageModel"],
): Selection | null {
  if (!override) return view.preferredSelection ?? null;
  if (!view.effectiveSelection)
    throw new Error(
      `Git commit message model is unavailable: ${override.providerId}/${override.modelId}`,
    );
  return view.effectiveSelection;
}

/** Wait for the final result (prompt ACK is only admission); subscribe before sending. */
async function generate(
  proc: NekRpcProcess,
  selection: Selection,
  prompt: string,
  timeoutMs: number,
) {
  const signal = AbortSignal.timeout(timeoutMs);
  const ctx = { signal, deadline: Date.now() + timeoutMs };
  const state = await proc.client.call<"get_state">({ type: "get_state" }, ctx);
  if (
    state.sessionFile ||
    state.model?.provider !== selection.providerId ||
    state.model.id !== selection.modelId
  ) {
    throw new Error("nek did not open an ephemeral session with the requested model");
  }
  let lastError = "";
  const offMessage = proc.client.onEvent("message_end", ({ message }) => {
    if (
      message &&
      typeof message === "object" &&
      "errorMessage" in message &&
      typeof message.errorMessage === "string"
    )
      lastError = message.errorMessage.slice(0, 1024);
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const offSettled = proc.client.onEvent("agent_settled", ({ outcome }) => {
    if (outcome === "completed") resolve();
    else reject(new Error(lastError || `nek generation ended: ${String(outcome)}`));
  });
  const offExit = proc.client.onExit(() =>
    reject(new Error("nek exited before returning a commit message")),
  );
  const abort = () => reject(new Error("Git commit message generation timed out"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    await Promise.all([
      promise,
      proc.client.call<"prompt">({ type: "prompt", message: prompt }, ctx),
    ]);
    const { text } = await proc.client.call<"get_last_assistant_text">(
      { type: "get_last_assistant_text" },
      ctx,
    );
    if (!text?.trim()) throw new Error("nek returned no commit message");
    return { text, selection };
  } finally {
    offMessage();
    offSettled();
    offExit();
    signal.removeEventListener("abort", abort);
  }
}

/** Runs on the Git host (desktop or gui-server), never borrows a writable chat session. */
export function createNekCommitMessageRuntime(
  config = DEFAULT_GUI_RUNTIME_CONFIG,
  locator: Pick<NekLocator, "locate"> = new NekLocator(),
  spawn = createNekRpcProcess,
) {
  let active = 0;
  return {
    async generateText({
      workspacePath,
      selection,
      prompt,
    }: {
      workspacePath: string;
      selection: Selection;
      prompt: string;
    }) {
      if (active >= 2)
        throw new Error("Git message generation is busy; retry after the current request");
      active++;
      try {
        const { info } = await locator.locate();
        const proc = spawn({
          guiInfo: info,
          cwd: workspacePath,
          approve: false,
          extraArgs: [
            "--no-session",
            "--no-tools",
            "--no-extensions",
            "--no-context-files",
            "--no-skills",
            "--no-prompt-templates",
            "--provider",
            selection.providerId,
            "--model",
            selection.modelId,
            ...(selection.options?.reasoningLevel
              ? ["--thinking", selection.options.reasoningLevel]
              : []),
          ],
          client: { closeGraceMs: config.timeouts.shutdownGraceMs },
        });
        try {
          return await generate(proc, selection, prompt, config.timeouts.longRunningMs);
        } finally {
          await proc.dispose();
        }
      } finally {
        active--;
      }
    },
  };
}
