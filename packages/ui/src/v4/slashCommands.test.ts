import { describe, expect, it } from "vitest";
import { parseV4VisibleSlashCommand } from "./slashCommands.js";

describe("visible slash commands", () => {
  it.each(["/goal", "/goal resume", "/goal new objective", "/target replace objective"])(
    "SC-5 does not parse former goal input %s as a GUI command",
    (text) => expect(parseV4VisibleSlashCommand(text)).toBeNull(),
  );
});
