import { expect, it } from "vitest";
import { buildDefaultToolsSetting, resolveDefaultTools } from "./defaultTools.js";

const defaults = ["read", "bash", "web_search"];
const known = [...defaults, "powershell"];

it.each([
  { setting: undefined, enabled: defaults },
  { setting: [], enabled: [] },
  { setting: ["  ", "\t\n"], enabled: [] },
  { setting: ["+powershell"], enabled: [...defaults, "powershell"] },
  { setting: [" - web_search ", "+ powershell"], enabled: ["read", "bash", "powershell"] },
  { setting: [" read ", "+read", "-read", "+powershell"], enabled: ["read", "powershell"] },
  { setting: ["future", "+powershell"], enabled: ["powershell"], unknown: ["future"] },
  {
    setting: [" +future ", " - ", " +future "],
    enabled: defaults,
    unknown: [" +future ", " - ", " +future "],
  },
])("SR-5 resolves nek's tool syntax: $setting", ({ setting, enabled, unknown }) => {
  expect(resolveDefaultTools(setting, defaults, known)).toEqual({
    enabled: new Set(enabled),
    unknown: unknown ?? [],
  });
});

it("SR-5 writes changes in the original style, including an explicit empty list", () => {
  const write = (selection: string[], original?: string[]) =>
    buildDefaultToolsSetting(new Set(selection), defaults, known, original);
  expect(write(defaults)).toBeNull();
  expect(write(["read", "bash"], undefined)).toEqual(["-web_search"]);
  expect(write([], ["-web_search"])).toEqual(["-read", "-bash", "-web_search"]);
  expect(write(["read"], [])).toEqual(["read"]);
  expect(write(["read"], [" ", "\t"])).toEqual(["read"]);
  expect(write([], ["read"])).toEqual([]);
  expect(write(defaults, ["read"])).toEqual(defaults);
  expect(write([], ["read", " +future "])).toEqual(["read", "-read", " +future "]);
});

it.each(
  [
    undefined,
    [],
    ["  ", ""],
    ["read", " +future "],
    ["read", " future ", " - futureOff "],
    [" future ", " -future ", "+powershell"],
    [" +future ", " +future ", "-web_search", "-"],
  ].map((original) => ({ original })),
)("SR-5 all selections round-trip without losing unknown entries: $original", ({ original }) => {
  const { unknown } = resolveDefaultTools(original, defaults, known);
  for (let mask = 0; mask < 1 << known.length; mask += 1) {
    const selection = new Set(known.filter((_name, index) => (mask & (1 << index)) !== 0));
    const next = buildDefaultToolsSetting(selection, defaults, known, original);
    expect(resolveDefaultTools(next ?? undefined, defaults, known)).toEqual({
      enabled: selection,
      unknown,
    });
  }
});
