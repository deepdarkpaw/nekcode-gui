// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InstructionsEditor } from "./InstructionsEditor.js";
import { useNekTargetSelection } from "../../api/NekSettingsContext.js";
import { MOCK_REMOTE_CONNECTED } from "../../api/mock/mockSeed.js";
import {
  createNekTestEnv,
  flushNek,
  installDomPolyfills,
  type NekTestEnv,
} from "../../test/nekTestUtils.js";

const LOCAL = { kind: "local" } as const;
const TITLE = "全局 AGENTS.md";
const ORIGINAL = "# Workspace instructions\n\nPreserve user intent.\n中文指令也必须完整显示。\n";
let env: NekTestEnv;

beforeEach(() => {
  installDomPolyfills();
  env = createNekTestEnv({ latencyMs: 10 });
  env.config.machines.get("local")!.instructions.value = ORIGINAL;
});
afterEach(() => cleanup());

function input(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: TITLE }) as HTMLTextAreaElement;
}
async function showEditor() {
  render(<InstructionsEditor scope="global" title={TITLE} />, { wrapper: env.wrapper });
  await screen.findByRole("textbox", { name: TITLE });
}
function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^保存/ }) as HTMLButtonElement;
}
async function changedOutside(content: string) {
  act(() => {
    env.config.simulateExternalEdit(LOCAL, "instructions", () => content);
  });
  await flushNek();
}

it("IN-1: an asynchronously loaded nonempty AGENTS.md is not mistaken for an unsaved empty draft", async () => {
  const write = vi.spyOn(env.config, "writeInstructions");
  await showEditor();
  await waitFor(() => expect(input().value).toBe(ORIGINAL));
  expect(screen.queryByText("有未保存的修改")).toBeNull();
  expect(saveButton().disabled).toBe(true);
  expect(write).not.toHaveBeenCalled();
});

it("IN-1: an empty file stays clean and is never automatically saved", async () => {
  env.config.machines.get("local")!.instructions.value = "";
  const write = vi.spyOn(env.config, "writeInstructions");
  await showEditor();
  expect(input().value).toBe("");
  expect(saveButton().disabled).toBe(true);
  expect(screen.queryByText("有未保存的修改")).toBeNull();
  expect(write).not.toHaveBeenCalled();
});

it("IN-2: clean external changes update the text without becoming an edit", async () => {
  await showEditor();
  await changedOutside("new external instructions\n");
  await waitFor(() => expect(input().value).toBe("new external instructions\n"));
  expect(saveButton().disabled).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("IN-2: an unsaved draft survives external changes, then reload adopts the new async document", async () => {
  await showEditor();
  fireEvent.change(input(), { target: { value: "my unsaved rules" } });
  await changedOutside("edited in another app\n");
  await screen.findByText("配置已在外部修改");
  expect(input().value).toBe("my unsaved rules");
  fireEvent.click(screen.getByRole("button", { name: "重新载入" }));
  await waitFor(() => expect(input().value).toBe("edited in another app\n"));
  expect(saveButton().disabled).toBe(true);
  expect(screen.queryByText("有未保存的修改")).toBeNull();
});

it("IN-2: keep mine retains a real draft across a refresh and can save with the latest revision", async () => {
  await showEditor();
  fireEvent.change(input(), { target: { value: "keep this draft" } });
  await changedOutside("external version");
  await screen.findByText("配置已在外部修改");
  const read = vi.spyOn(env.config, "readInstructions");
  fireEvent.click(screen.getByRole("button", { name: "保留我的修改" }));
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  await act(async () => {
    await read.mock.results[0]!.value;
  });
  await waitFor(() => expect(screen.queryByText("配置已在外部修改")).toBeNull());
  expect(input().value).toBe("keep this draft");
  fireEvent.click(saveButton());
  await waitFor(() =>
    expect(env.config.machines.get("local")!.instructions.value).toBe("keep this draft"),
  );
  await waitFor(() => expect(saveButton().disabled).toBe(true));
  await changedOutside("clean subsequent change");
  await waitFor(() => expect(input().value).toBe("clean subsequent change"));
});

it("IN-3: a failed save preserves the draft and allows a successful retry", async () => {
  await showEditor();
  fireEvent.change(input(), { target: { value: "do not lose my edit" } });
  env.config.failNext("writeInstructions", { code: "io", message: "EACCES: permission denied" });
  fireEvent.click(saveButton());
  await waitFor(() => expect(saveButton().getAttribute("data-async-state")).toBe("error"));
  expect(input().value).toBe("do not lose my edit");
  expect(env.config.machines.get("local")!.instructions.value).toBe(ORIGINAL);
  expect(saveButton().disabled).toBe(false);
  fireEvent.click(saveButton());
  await waitFor(() =>
    expect(env.config.machines.get("local")!.instructions.value).toBe("do not lose my edit"),
  );
  await waitFor(() => expect(saveButton().disabled).toBe(true));
  await changedOutside("external after successful save");
  await waitFor(() => expect(input().value).toBe("external after successful save"));
});

it("IN-3: conflict keep-mine retry failure must not consume the pending draft", async () => {
  await showEditor();
  fireEvent.change(input(), { target: { value: "my conflict draft" } });
  await changedOutside("someone else's version");
  await screen.findByText("配置已在外部修改");
  fireEvent.click(saveButton());
  await waitFor(() => expect(saveButton().getAttribute("data-async-state")).toBe("error"));
  env.config.failNext("writeInstructions", { code: "io", message: "write still unavailable" });
  fireEvent.click(screen.getByRole("button", { name: "保留我的修改" }));
  await waitFor(() => expect(screen.queryByText("配置已在外部修改")).toBeNull());
  await flushNek(15);
  expect(input().value).toBe("my conflict draft");
  expect(saveButton().disabled).toBe(false);
  expect(env.config.machines.get("local")!.instructions.value).toBe("someone else's version");
  fireEvent.click(saveButton());
  await waitFor(() =>
    expect(env.config.machines.get("local")!.instructions.value).toBe("my conflict draft"),
  );
});

it("IN-3: intentionally clearing the file is a real empty draft that can be saved", async () => {
  await showEditor();
  fireEvent.change(input(), { target: { value: "" } });
  expect(input().value).toBe("");
  expect(saveButton().disabled).toBe(false);
  fireEvent.click(saveButton());
  await waitFor(() => expect(env.config.machines.get("local")!.instructions.value).toBe(""));
  await waitFor(() => expect(saveButton().disabled).toBe(true));
  await changedOutside("restored externally");
  await waitFor(() => expect(input().value).toBe("restored externally"));
});

it("IN-3: edits made during a pending save survive the older successful acknowledgement", async () => {
  await showEditor();
  const original = env.config.writeInstructions.bind(env.config);
  const gate = Promise.withResolvers<void>();
  const write = vi.spyOn(env.config, "writeInstructions").mockImplementation(async (...args) => {
    await gate.promise;
    return original(...args);
  });
  fireEvent.change(input(), { target: { value: "first edit" } });
  fireEvent.click(saveButton());
  await waitFor(() => expect(write).toHaveBeenCalledOnce());
  fireEvent.change(input(), { target: { value: "second edit while saving" } });
  await act(async () => {
    gate.resolve();
    await flushNek(15);
  });
  await waitFor(() => expect(saveButton().getAttribute("data-async-state")).not.toBe("pending"));
  expect(input().value).toBe("second edit while saving");
  expect(saveButton().disabled).toBe(false);
  expect(env.config.machines.get("local")!.instructions.value).toBe("first edit");
});

it("IN-3: revert restores the loaded content without writing anything", async () => {
  const write = vi.spyOn(env.config, "writeInstructions");
  await showEditor();
  fireEvent.change(input(), { target: { value: "discard" } });
  fireEvent.click(screen.getByRole("button", { name: "还原" }));
  expect(input().value).toBe(ORIGINAL);
  expect(saveButton().disabled).toBe(true);
  expect(write).not.toHaveBeenCalled();
});

it("IN-4: switching targets drops the previous target's draft without writing to either file", async () => {
  env.config.machines.get(`remote:${MOCK_REMOTE_CONNECTED}`)!.instructions.value = "remote rules\n";
  const write = vi.spyOn(env.config, "writeInstructions");
  await showEditor();
  fireEvent.change(input(), { target: { value: "local only draft" } });
  act(() => {
    useNekTargetSelection
      .getState()
      .setTarget({ kind: "remote", connectionId: MOCK_REMOTE_CONNECTED });
  });
  await waitFor(() => expect(input().value).toBe("remote rules\n"));
  expect(saveButton().disabled).toBe(true);
  act(() => {
    useNekTargetSelection.getState().setTarget(LOCAL);
  });
  await waitFor(() => expect(input().value).toBe(ORIGINAL));
  expect(write).not.toHaveBeenCalled();
});

it("IN-4: project cwd changes use their own content and discard the other project's draft", async () => {
  const local = env.config.machines.get("local")!;
  local.projectInstructions.set("/project-a", {
    path: "/project-a/AGENTS.md",
    revision: "a1",
    value: "project A",
  });
  local.projectInstructions.set("/project-b", {
    path: "/project-b/AGENTS.md",
    revision: "b1",
    value: "project B",
  });
  const view = render(<InstructionsEditor scope="project" cwd="/project-a" title={TITLE} />, {
    wrapper: env.wrapper,
  });
  await waitFor(() => expect(input().value).toBe("project A"));
  fireEvent.change(input(), { target: { value: "draft for A" } });
  view.rerender(<InstructionsEditor scope="project" cwd="/project-b" title={TITLE} />);
  await waitFor(() => expect(input().value).toBe("project B"));
  expect(saveButton().disabled).toBe(true);
  expect(local.projectInstructions.get("/project-a")!.value).toBe("project A");
});

it("IN-4: a late read from the previous target cannot replace the new target's document", async () => {
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof env.config.readInstructions>>>();
  const read = env.config.readInstructions.bind(env.config);
  const calls = vi
    .spyOn(env.config, "readInstructions")
    .mockImplementation((target, ...args) =>
      target.kind === "local" ? gate.promise : read(target, ...args),
    );
  env.config.machines.get(`remote:${MOCK_REMOTE_CONNECTED}`)!.instructions.value =
    "remote document";
  render(<InstructionsEditor scope="global" title={TITLE} />, { wrapper: env.wrapper });
  await waitFor(() => expect(calls).toHaveBeenCalled());
  act(() => {
    useNekTargetSelection
      .getState()
      .setTarget({ kind: "remote", connectionId: MOCK_REMOTE_CONNECTED });
  });
  await waitFor(() => expect(input().value).toBe("remote document"));
  await act(async () => {
    gate.resolve({
      path: "/local/AGENTS.md",
      revision: "late-local",
      content: "late local document",
    });
  });
  expect(input().value).toBe("remote document");
  expect(saveButton().disabled).toBe(true);
});
