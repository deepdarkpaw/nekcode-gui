import type { ModelSelection } from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type {
  NekBuiltinSlashCommandName,
  NekBuiltinSlashInvocation,
  NekSessionReloadOutcome,
} from "@zcode/shared/nek-protocol";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { NekSettingsSectionId } from "@/settings/nek/sectionIds.js";

type SettingsDestination = Extract<
  NekSettingsSectionId,
  "nekAccounts" | "nekDefaultModel" | "nekProject" | "nekShortcuts"
>;

const PLANNED_COMMANDS = ["tree", "share", "clone", "changelog"] as const;
type PlannedCommand = (typeof PLANNED_COMMANDS)[number];

function isPlannedCommand(name: NekBuiltinSlashCommandName): name is PlannedCommand {
  return PLANNED_COMMANDS.some((command) => command === name);
}

/** Listed in completion only if the GUI can do more than show a notice. */
export function hasBuiltinSlashAction(name: NekBuiltinSlashCommandName): boolean {
  return name !== "quit" && !isPlannedCommand(name);
}

export type BuiltinSlashPicker = "model" | "thought";
export type BuiltinSlashDialog = "rename" | "session";

interface SlashNotice {
  id: string;
  values?: Record<string, string | number>;
  variant?: "info" | "warning";
}

interface SlashOutcome {
  status: "sent" | "blocked";
  notice?: SlashNotice;
}

interface SlashActionPorts {
  sessionId: string | null;
  modelView: ModelSelectionView | null;
  currentSelection: ModelSelection | undefined;
  openPicker: (picker: BuiltinSlashPicker) => boolean;
  selectModel: (provider: string, model: string) => void;
  selectThinking: (level: string) => void;
  openSettings: (section?: SettingsDestination) => boolean;
  newSession: () => boolean;
  openDialog: (kind: BuiltinSlashDialog) => void;
  rename: (title: string) => Promise<void>;
  compact: (instructions: string | undefined) => Promise<{ ack: CommandAck; queued: boolean }>;
  readLastAssistantText: () => Promise<string | null>;
  writeClipboard: (text: string) => Promise<void>;
  reload: () => Promise<NekSessionReloadOutcome>;
  focusSessionSearch: () => boolean;
  focusFork: () => boolean;
  openTaskArchive: (mode: "import" | "export", isCurrent: () => boolean) => boolean;
}

const SENT: SlashOutcome = { status: "sent" };

function blocked(
  id: string,
  values?: SlashNotice["values"],
  variant: SlashNotice["variant"] = "warning",
): SlashOutcome {
  return { status: "blocked", notice: { id, values, variant } };
}

function sentWithNotice(id: string, values?: SlashNotice["values"]): SlashOutcome {
  return { status: "sent", notice: { id, values, variant: "info" } };
}

function opened(open: boolean): SlashOutcome {
  return open ? SENT : blocked("chat.slash.actionUnavailable");
}

function selectModel(args: string, ports: SlashActionPorts): SlashOutcome {
  if (!ports.modelView) return blocked("chat.slash.modelUnavailable");
  if (!args) return opened(ports.openPicker("model"));
  // Real menu candidates come from the target Host. Compare the full reference so model IDs can contain '/'.
  const reference = args.toLowerCase();
  for (const provider of ports.modelView.providers) {
    const model = provider.models.find(
      (candidate) => `${provider.providerId}/${candidate.modelId}`.toLowerCase() === reference,
    );
    if (!model) continue;
    ports.selectModel(provider.providerId, model.modelId);
    return SENT;
  }
  return blocked("chat.slash.unknownModel", { model: args });
}

function selectThinking(args: string, ports: SlashActionPorts): SlashOutcome {
  if (!ports.modelView) return blocked("chat.slash.modelUnavailable");
  const selection = ports.currentSelection;
  const levels = ports.modelView.providers
    .find((provider) => provider.providerId === selection?.providerId)
    ?.models.find((model) => model.modelId === selection?.modelId)?.reasoningLevels;
  if (!levels?.length) return blocked("chat.slash.thinkingNoModel");
  if (!args) return opened(ports.openPicker("thought"));
  const level = levels.find((candidate) => candidate.toLowerCase() === args.toLowerCase());
  if (!level)
    return blocked("chat.slash.unknownThinking", { level: args, levels: levels.join(", ") });
  ports.selectThinking(level);
  return SENT;
}

async function compact(args: string, ports: SlashActionPorts): Promise<SlashOutcome> {
  const { ack, queued } = await ports.compact(args || undefined);
  if (ack.reasonCode === "compactOperationLock") return blocked("chat.compact.duplicateBlocked");
  if (ack.reasonCode === "activeTurn") return blocked("chat.compact.runningBlocked");
  if (ack.status !== "accepted" && ack.status !== "duplicate" && ack.status !== "noop") {
    throw new Error(ack.message ?? ack.reasonCode ?? ack.status);
  }
  return queued ? sentWithNotice("chat.compact.queued") : SENT;
}

async function reload(ports: SlashActionPorts): Promise<SlashOutcome> {
  const { reloaded, deferred, diagnostics, failures } = await ports.reload();
  const diagnosticsError = diagnostics.find((item) => item.severity === "error");
  if (failures.length > 0) {
    return blocked("settings.nek.reload.failed", {
      count: failures.length,
      reason: failures[0]!.message,
    });
  }
  if (diagnosticsError)
    return blocked("chat.slash.reloadConfigError", { reason: diagnosticsError.message });
  const warning = diagnostics[0];
  return warning
    ? sentWithNotice("chat.slash.reloadWarning", { reloaded, deferred, reason: warning.message })
    : sentWithNotice("settings.nek.advanced.reloadResult", { reloaded, deferred });
}

/** Renderer routing is exhaustive; none of these ports can send a prompt. */
export async function executeBuiltinSlashCommand(
  { name, args }: NekBuiltinSlashInvocation,
  hasAttachments: boolean,
  ports: SlashActionPorts,
  isCurrent: () => boolean,
): Promise<SlashOutcome> {
  if (name === "quit") return blocked("chat.slash.quitHint", undefined, "info");
  if (isPlannedCommand(name)) return blocked("chat.slash.planned", { name }, "info");
  if (hasAttachments) return blocked("chat.slash.attachmentsBlocked");
  switch (name) {
    case "import":
    case "export":
      if (args) return blocked("taskArchive.slashNoArgs", { name });
      if (name === "export" && !ports.sessionId) return blocked("taskArchive.noTask");
      return ports.openTaskArchive(name, isCurrent) ? SENT : blocked("taskArchive.unavailable");
    case "model":
      return selectModel(args, ports);
    case "thinking":
      return selectThinking(args, ports);
    case "scoped-models":
      return opened(ports.openSettings("nekDefaultModel"));
    case "new":
      return opened(ports.newSession());
    case "name":
      if (!ports.sessionId) return blocked("chat.slash.needsSession");
      if (args) await ports.rename(args);
      else ports.openDialog("rename");
      return SENT;
    case "session":
      if (!ports.sessionId) return blocked("chat.slash.needsSession");
      ports.openDialog("session");
      return SENT;
    case "compact":
      if (!ports.sessionId) return blocked("chat.slash.needsSession");
      return await compact(args, ports);
    case "copy": {
      const text = ports.sessionId ? await ports.readLastAssistantText() : null;
      if (!isCurrent()) return { status: "blocked" };
      if (!text) return blocked("chat.slash.noAnswer", undefined, "info");
      await ports.writeClipboard(text);
      return sentWithNotice("chat.slash.copied");
    }
    case "settings":
      return opened(ports.openSettings());
    case "hotkeys":
      return opened(ports.openSettings("nekShortcuts"));
    case "login":
    case "logout":
      return opened(ports.openSettings("nekAccounts"));
    case "trust":
      return opened(ports.openSettings("nekProject"));
    case "resume":
      return opened(ports.focusSessionSearch());
    case "fork":
      return ports.focusFork()
        ? sentWithNotice("chat.slash.forkHint")
        : blocked("chat.slash.forkUnavailable", undefined, "info");
    case "reload":
      return await reload(ports);
  }
}
