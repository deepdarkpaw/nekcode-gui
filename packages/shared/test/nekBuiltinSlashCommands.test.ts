import assert from "node:assert/strict";
import test from "node:test";
import {
  NEK_BUILTIN_SLASH_COMMANDS,
  isNekBuiltinSlashCommandName,
} from "../src/nek-protocol/builtin-slash-commands.js";

test("SC-1 mirrors the nek v0.5.1 catalog exactly, including order and argument hints", () => {
  assert.deepEqual(
    NEK_BUILTIN_SLASH_COMMANDS.map((command) => Object.values(command)),
    [
      ["settings", "Open settings menu"],
      ["model", "Select model (opens selector UI)", "<provider/model>"],
      ["tree", "Navigate session tree (switch branches)"],
      ["thinking", "Set thinking level", "<level>"],
      ["scoped-models", "Enable/disable models for Ctrl+P cycling"],
      ["export", "Export session (HTML default, or specify path: .html/.jsonl)"],
      ["import", "Import and resume a session from a JSONL file"],
      ["share", "Share session as a secret GitHub gist"],
      ["copy", "Copy last agent message to clipboard"],
      ["name", "Set session display name"],
      ["session", "Show session info and stats"],
      ["changelog", "Show changelog entries"],
      ["hotkeys", "Show all keyboard shortcuts"],
      ["fork", "Create a new fork from a previous user message"],
      ["clone", "Duplicate the current session at the current position"],
      ["trust", "Save project trust decision for future sessions"],
      ["login", "Configure provider authentication", "<provider>"],
      ["logout", "Remove provider authentication"],
      ["new", "Start a new session"],
      ["compact", "Manually compact the session context"],
      ["resume", "Resume a different session"],
      ["reload", "Reload keybindings, extensions, skills, prompts, themes, and context files"],
      ["quit", "Quit nek"],
    ],
  );
  assert(NEK_BUILTIN_SLASH_COMMANDS.every(({ name }) => isNekBuiltinSlashCommandName(name)));
  assert(!isNekBuiltinSlashCommandName("plan"));
  assert(!isNekBuiltinSlashCommandName("Model"));
  assert(!isNekBuiltinSlashCommandName("extension:model"));
});
