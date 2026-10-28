export type BuiltinZCodeSlashCommandHelpEntry = {
  aliases?: readonly string[];
  details: readonly string[];
  name: string;
  summary: string;
  usage: string;
};

export const BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES: readonly BuiltinZCodeSlashCommandHelpEntry[] =
  [
    {
      details: [
        "Shows command-center help locally without creating a session or sending a model prompt.",
        "Pass a command name with or without the leading slash for command-specific help.",
      ],
      name: "help",
      summary: "Show this slash command help.",
      usage: "/help [command]",
    },
    {
      details: ["Runs the core manual compaction path and forwards optional summary instructions."],
      name: "compact",
      summary: "Compact the current conversation with optional instructions.",
      usage: "/compact [instructions]",
    },
    {
      details: [
        "Runs a normal agent turn that inspects the current workspace and creates or updates AGENTS.md.",
        "Existing AGENTS.md files should be edited rather than overwritten.",
        "This command targets the workspace root, not the user default ~/.zcodium/AGENTS.md.",
      ],
      name: "init",
      summary: "Create or update workspace AGENTS.md instructions.",
      usage: "/init [notes]",
    },
    {
      aliases: ["variant"],
      details: [
        "In the TUI, type /effort or /variant to open composer suggestions.",
        "Submitting the empty command or list shows the current and selectable efforts as text.",
        "Use a listed level to switch the current session reasoning effort.",
      ],
      name: "effort",
      summary: "Show or switch the current session reasoning effort.",
      usage: "/effort [list|<level>]",
    },
    {
      details: [
        "In the TUI, opens a checkpoint picker when called without arguments.",
        "Use latest or a specific checkpoint id to bypass the picker.",
      ],
      name: "fork",
      summary: "Fork a new session from a workspace checkpoint.",
      usage: "/fork [latest|checkpointId]",
    },
    {
      aliases: ["language"],
      details: [
        "Shows the current UI locale when called without arguments.",
        "Use auto, en-US, or zh-CN to switch and persist the UI locale.",
      ],
      name: "locale",
      summary: "Show or switch the UI locale.",
      usage: "/locale [auto|en-US|zh-CN]",
    },
    {
      details: [
        "Lists MCP server status by default.",
        "Use connect or disconnect with a configured server name to manage the session connection.",
      ],
      name: "mcp",
      summary: "Show or manage configured MCP servers.",
      usage: "/mcp [list|status|connect <server>|disconnect <server>]",
    },
    {
      aliases: ["plugin"],
      details: [
        "Opens a TUI plugin panel when called without arguments.",
        "Rows show ✓ for enabled plugins and ○ for disabled plugins.",
        "Use enable or disable with a plugin id to persist the switch in user config.",
        "Plugin capability changes apply to new sessions.",
      ],
      name: "plugins",
      summary: "Open the plugin manager.",
      usage: "/plugins [list|enable <plugin>|disable <plugin>]",
    },
    {
      details: [
        "Shows the current mode when submitted without arguments.",
        "Interactive TUI composer input opens a local picker before submit.",
        "Switchable modes are agent and plan.",
        "Picker rows and explicit input submit /mode <mode> commands.",
      ],
      name: "mode",
      summary: "Show or switch the current mode.",
      usage: "/mode [agent|plan]",
    },
    {
      details: [
        "Shows the current and selectable models when called without arguments or with list.",
        "Use a provider/model id to select a model with its default reasoning effort; use /effort to change the effort.",
      ],
      name: "model",
      summary: "Show or switch the current session model.",
      usage: "/model [list|provider/model]",
    },
    {
      aliases: ["clear"],
      details: ["Starts a fresh root session and resets the TUI session projection."],
      name: "new",
      summary: "Start a fresh session in the TUI.",
      usage: "/new",
    },
    {
      aliases: ["continue"],
      details: [
        "In the TUI, opens a session picker when called without arguments.",
        "Resumes a specific session id when provided.",
        "/continue resumes the latest root session for the current directory.",
      ],
      name: "resume",
      summary: "Resume a saved session.",
      usage: "/resume [sessionId]",
    },
    {
      details: [
        "In the TUI, opens a checkpoint picker when called without arguments.",
        "Use status to show the latest checkpoint, or latest/a checkpoint id to restore directly.",
      ],
      name: "rewind",
      summary: "Inspect or restore workspace checkpoints.",
      usage: "/rewind [latest|checkpointId]",
    },
    {
      details: [
        "Without a name, lists discoverable skills for the current working directory.",
        "With a name, rewrites the next prompt so the Skill tool must load that skill first.",
      ],
      name: "skill",
      summary: "List skills, or force the next prompt to load one.",
      usage: "/skill [<skill-name> [task]]",
    },
    {
      aliases: ["target"],
      details: [
        "Shows the current session goal when called without arguments.",
        "Setting a new objective overwrites an existing goal; replace is an explicit alias.",
        "Use pause, resume, or clear to manage the current goal.",
      ],
      name: "goal",
      summary: "Show or set the current session goal.",
      usage: "/goal [pause|resume|clear|replace <objective>|<objective>]",
    },
  ] as const;
