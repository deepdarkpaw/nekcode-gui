/** nek v0.5.1 `core/tool-names.ts`: mirror the syntax, but take names/defaults from list_builtin_tools. */
export const WEB_SEARCH_TOOL = "web_search";

type ToolEntry = { raw: string; name: string; prefix: "+" | "-" | undefined };

function parse(entries: readonly string[]): ToolEntry[] {
  const parsed: ToolEntry[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    const prefix = entry[0] === "+" || entry[0] === "-" ? entry[0] : undefined;
    parsed.push({ raw, name: prefix ? entry.slice(1).trim() : entry, prefix });
  }
  return parsed;
}

/** Core removes before adding, regardless of the order of the + / - entries. */
export function resolveDefaultTools(
  setting: readonly string[] | undefined,
  defaults: readonly string[],
  knownTools: readonly string[],
): { enabled: Set<string>; unknown: string[] } {
  const known = new Set(knownTools);
  const entries = parse(setting ?? []);
  const absolute = entries.filter(({ prefix }) => prefix === undefined);
  const base =
    setting && entries.length === 0
      ? []
      : absolute.length > 0
        ? absolute.map(({ name }) => name)
        : defaults;
  const enabled = new Set(base.filter((name) => known.has(name)));
  for (const { name, prefix } of entries) if (prefix === "-") enabled.delete(name);
  for (const { name, prefix } of entries) if (prefix === "+" && known.has(name)) enabled.add(name);
  return { enabled, unknown: entries.filter(({ name }) => !known.has(name)).map(({ raw }) => raw) };
}

/** Preserve absolute/relative syntax and unknown entries while encoding exactly the chosen set. */
export function buildDefaultToolsSetting(
  enabled: ReadonlySet<string>,
  defaults: readonly string[],
  knownTools: readonly string[],
  original?: readonly string[],
): string[] | null {
  const known = new Set(knownTools);
  const parsed = parse(original ?? []);
  const absolute = parsed.filter(({ prefix }) => prefix === undefined);
  const unknown = parsed.filter(({ name }) => !known.has(name));
  const unchanged = unknown.map(({ raw }) => raw);
  if (original && (parsed.length === 0 || absolute.length > 0)) {
    const selected = [...known].filter((name) => enabled.has(name));
    if (selected.length === 0 && unknown.length > 0 && unknown.every(({ prefix }) => prefix)) {
      // Keeping only unknown deltas would start from the defaults. Keep one known absolute
      // entry and remove it, so the result stays absolute and still enables nothing.
      const anchor = absolute[0]?.name;
      if (anchor) return [anchor, `-${anchor}`, ...unchanged];
    }
    return [...selected, ...unchanged];
  }

  const defaultSet = new Set(defaults);
  const deltas: string[] = [];
  for (const name of known) {
    if (enabled.has(name) && !defaultSet.has(name)) deltas.push(`+${name}`);
    if (!enabled.has(name) && defaultSet.has(name)) deltas.push(`-${name}`);
  }
  const setting = [...deltas, ...unchanged];
  return setting.length > 0 ? setting : null;
}
