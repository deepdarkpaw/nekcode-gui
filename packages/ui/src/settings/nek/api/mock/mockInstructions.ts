import {
  NEK_INSTRUCTION_FILE_NAMES,
  type NekConfigScope,
  type NekInstructionFile,
  type NekInstructionsView,
} from "@zcode/shared/nek-protocol";
import { mockError, mockFile, type MockFile, type MockMachine } from "./mockMachine.js";
import type { Touch } from "./mockModels.js";

function ref({ path }: MockFile<string>): NekInstructionFile {
  return { path, filename: path.slice(path.lastIndexOf("/") + 1) };
}

function contextFiles(machine: MockMachine, dir: string): MockFile<string>[] {
  const primary =
    dir === machine.agentDir ? machine.instructions : machine.projectInstructions.get(dir);
  return NEK_INSTRUCTION_FILE_NAMES.flatMap((name) => {
    const path = `${dir}/${name}`;
    const file = path === primary?.path ? primary : machine.otherInstructionFiles.get(path);
    return file && file.revision !== "absent" ? [file] : [];
  });
}

function instructionDirectory(machine: MockMachine, scope: NekConfigScope, cwd?: string): string {
  const dir = scope === "global" ? machine.agentDir : cwd;
  if (!dir) throw mockError("validation", "project scope requires cwd");
  return dir;
}

export function readInstructions(
  machine: MockMachine,
  scope: NekConfigScope,
  cwd?: string,
): NekInstructionsView {
  const dir = instructionDirectory(machine, scope, cwd);
  const [file = mockFile(`${dir}/AGENTS.md`, "", false), ...ignored] = contextFiles(machine, dir);
  const ancestors: NekInstructionFile[] = [];
  if (scope === "project") {
    let parent = dir;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      const [ancestor] = contextFiles(machine, parent);
      if (ancestor && parent !== machine.agentDir) ancestors.unshift(ref(ancestor));
    }
  }
  return {
    ...ref(file),
    revision: file.revision,
    content: file.value,
    ignored: ignored.map(ref),
    ancestors,
    diagnostics: [],
  };
}

export function writeInstructions(
  machine: MockMachine,
  scope: NekConfigScope,
  content: string,
  options: { path: string; revision: string; cwd?: string },
  touch: Touch,
): string {
  const dir = instructionDirectory(machine, scope, options.cwd);
  const [active] = contextFiles(machine, dir);
  const file = active ?? mockFile(`${dir}/AGENTS.md`, "", false);
  if (file.path !== options.path || file.revision !== options.revision)
    throw mockError("conflict", `${options.path} was modified externally`);
  if (!active) {
    if (scope === "global") machine.instructions = file;
    else machine.projectInstructions.set(dir, file);
  }
  file.value = content;
  return touch(file);
}
