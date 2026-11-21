import type {
  NekResourceCatalog,
  NekResourceFileRef,
  NekResourceInfo,
  NekResourceQuery,
  INekResourceConfigApi,
} from "@zcode/shared/nek-protocol";
import {
  assertRevision,
  mockError,
  mockFile,
  type MockFile,
  type MockMachine,
} from "./mockMachine.js";

type Entry = { info: NekResourceInfo; file: MockFile<string> };
export type MockResourceStore = WeakMap<MockMachine, Map<string, Entry>>;

function catalog(
  machine: MockMachine,
  { resourceType, cwd }: NekResourceQuery,
): NekResourceCatalog {
  return {
    roots: {
      global: `${machine.agentDir}/${resourceType}`,
      ...(cwd ? { project: `${cwd}/.nek/${resourceType}` } : {}),
    },
    projectTrusted: Boolean(
      cwd && (machine.trust.get(cwd) ?? machine.settings.value.defaultProjectTrust === "always"),
    ),
    resources: [],
    diagnostics: [],
  };
}

function entries(store: MockResourceStore, machine: MockMachine): Map<string, Entry> {
  let list = store.get(machine);
  if (!list) {
    list = new Map();
    store.set(machine, list);
    for (const [resourceType, name, description] of [
      ["skills", "pdf", "Read PDF files"],
      ["prompts", "review", "Review staged changes"],
    ] as const) {
      const path = `${machine.agentDir}/${resourceType}/${resourceType === "skills" ? `${name}/SKILL.md` : `${name}.md`}`;
      list.set(path, {
        info: {
          resourceType,
          name,
          description,
          path,
          scope: "user",
          source: "auto",
          enabled: true,
          toggleable: true,
        },
        file: mockFile(path, `${description}\n`),
      });
    }
  }
  return list;
}

export function listMockResources(
  store: MockResourceStore,
  machine: MockMachine,
  query: NekResourceQuery,
): NekResourceCatalog {
  const result = catalog(machine, query);
  for (const { info } of entries(store, machine).values()) {
    if (info.resourceType !== query.resourceType) continue;
    if (
      info.scope === "project" &&
      (!result.projectTrusted || !info.path.startsWith(`${result.roots.project}/`))
    )
      continue;
    result.resources.push(info);
  }
  return result;
}

export function getMockResource(
  store: MockResourceStore,
  machine: MockMachine,
  ref: NekResourceFileRef,
): Entry {
  if (!listMockResources(store, machine, ref).resources.some((entry) => entry.path === ref.path)) {
    throw mockError("validation", `Unknown resource ${ref.path}`);
  }
  return entries(store, machine).get(ref.path)!;
}

export function createMockResource(
  store: MockResourceStore,
  machine: MockMachine,
  input: Parameters<INekResourceConfigApi["createResource"]>[1],
) {
  const result = catalog(machine, input);
  if (input.scope === "project" && !result.projectTrusted)
    throw mockError("validation", "Project not trusted");
  const path = `${result.roots[input.scope]}/${input.resourceType === "skills" ? `${input.name}/SKILL.md` : `${input.name}.md`}`;
  const list = entries(store, machine);
  if (list.has(path) || list.size >= 512)
    throw mockError("validation", `Cannot create resource ${path}`);
  const info: NekResourceInfo = {
    path,
    resourceType: input.resourceType,
    name: input.name,
    description: input.description,
    scope: input.scope === "global" ? "user" : "project",
    source: "auto",
    enabled: true,
    toggleable: true,
  };
  const file = mockFile(path, input.content);
  list.set(path, { info, file });
  return file;
}

export function writeMockResource(
  store: MockResourceStore,
  machine: MockMachine,
  input: Parameters<INekResourceConfigApi["writePromptTemplate"]>[1],
) {
  const { file } = getMockResource(store, machine, input);
  assertRevision(file, input.revision);
  file.value = input.content;
  return file;
}

export function deleteMockResource(
  store: MockResourceStore,
  machine: MockMachine,
  input: NekResourceFileRef,
) {
  const { file } = getMockResource(store, machine, input);
  entries(store, machine).delete(input.path);
  return file;
}
