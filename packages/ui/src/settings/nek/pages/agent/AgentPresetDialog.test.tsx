// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNekTestEnv, installDomPolyfills } from "../../test/nekTestUtils.js";
import { AgentPresetDialog } from "./AgentPresetDialog.js";

beforeEach(() => installDomPolyfills());
afterEach(() => cleanup());

it.each(["gpt-6.1-sol-worker", "代码审查 GPT-6.1"])(
  "edits %s without renaming it",
  async (name) => {
    const initial = { name, description: "Before", instructions: "" };
    const onSave = vi.fn(async () => undefined);
    render(
      <AgentPresetDialog
        open
        editing
        initial={initial}
        onOpenChange={() => undefined}
        allowProjectScope={false}
        takenNames={() => new Set()}
        models={[]}
        onSave={onSave}
      />,
      { wrapper: createNekTestEnv().wrapper },
    );
    fireEvent.change(screen.getByDisplayValue("Before"), { target: { value: "After" } });
    fireEvent.click(screen.getByRole("button", { name: "保存预设" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith("global", { ...initial, description: "After" }),
    );
  },
);
