import type { WorkspaceConfigSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { NekAgentService } from "../service/nekAgentService.js";
import { isNekState } from "../service/types.js";
import type { NekWorkspaceTarget } from "./types.js";
import { workspaceKey } from "./frameHelpers.js";

/** Read one workspace config from nek; independent reads share the same selected process. */
export async function readNekWorkspaceConfig(
  service: NekAgentService,
  target: NekWorkspaceTarget,
  sessionKey: string | undefined,
): Promise<WorkspaceConfigSnapshot> {
  const context = service.commandContext();
  const client = sessionKey ? context.target(sessionKey).client : await context.control();
  const [catalog, state, commands, extension] = await Promise.all([
    client.call({ type: "get_available_models" }),
    sessionKey ? client.call({ type: "get_state" }) : undefined,
    sessionKey ? service.getCommands(sessionKey) : [],
    sessionKey ? client.call({ type: "extension_call", method: "nek.get_state" }) : undefined,
  ]);
  const nekState = isNekState(extension?.result) ? extension.result : undefined;
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const workspaceId = workspaceKey(target);
  return {
    protocolVersion: 1,
    workspaceId,
    logEpoch: `nek-config:${workspaceId}`,
    config: {
      configOptions: [
        {
          id: "model",
          name: "模型",
          type: "select",
          currentValue: state?.model ? `${state.model.provider}/${state.model.id}` : "",
          options: catalog.models.map((model) => ({
            value: `${model.provider}/${model.id}`,
            name: model.name,
            ...(model.reasoning ? { description: "支持思考" } : {}),
            modelProviderId: model.provider,
            modelProviderName: model.provider,
            modelThoughtLevels: levels,
          })),
        },
        {
          id: "thought_level",
          name: "思考等级",
          type: "select",
          currentValue: state?.thinkingLevel ?? "medium",
          options: levels.map((value) => ({ value, name: value })),
        },
        {
          id: "mode",
          name: "模式",
          type: "select",
          currentValue: nekState?.mode ?? "agent",
          options: [
            { value: "agent", name: "Agent" },
            { value: "plan", name: "Plan" },
          ],
        },
      ],
      slashCommands: commands.map((command) => ({
        name: command.name,
        description: command.description ?? "",
        source: command.source === "extension" ? "custom" : "builtin",
      })),
    },
  };
}
