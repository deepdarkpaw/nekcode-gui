/** Bare nek session UUIDs are internal references, never filesystem paths or URL schemes. */
const SUBAGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE_PREFIX = "#nek-subagent:";

/** Do not decode or normalize destinations: encoded paths must not acquire an internal capability. */
export function parseSubagentLink(href: string): string | null {
  const id = href.startsWith(REFERENCE_PREFIX) ? href.slice(REFERENCE_PREFIX.length) : href;
  return SUBAGENT_ID.test(id) ? id : null;
}

interface LinkNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: LinkNode[];
}

/** Run before sanitize/harden; a safe fragment preserves the label through the normal security pipeline. */
export function subagentLinkRehypePlugin() {
  return (tree: LinkNode) => {
    const pending = [tree];
    while (pending.length) {
      const node = pending.pop()!;
      const href = node.properties?.href;
      if (node.type === "element" && node.tagName === "a" && typeof href === "string") {
        const id = parseSubagentLink(href);
        if (id) node.properties!.href = `${REFERENCE_PREFIX}${id}`;
      }
      if (node.children) for (const child of node.children) pending.push(child);
    }
  };
}

type SubagentTextPart = { text: string } | { id: string; label: string };

/** Cheap inline references for plaintext thinking; code spans/fences and escaped links stay literal. */
export function splitSubagentText(text: string): SubagentTextPart[] {
  const pattern = /(`+|~{3,})|\[([^[\]\n]{1,256})\]\(([0-9a-f-]{36})\)/gi;
  const parts: SubagentTextPart[] = [];
  let literalStart = 0;
  let codeDelimiter: string | undefined;
  for (const match of text.matchAll(pattern)) {
    let slashCount = 0;
    for (let at = match.index - 1; at >= 0 && text[at] === "\\"; at -= 1) slashCount += 1;
    if (slashCount % 2 !== 0) continue;
    const delimiter = match[1];
    if (delimiter) {
      if (delimiter === codeDelimiter) codeDelimiter = undefined;
      else if (!codeDelimiter) codeDelimiter = delimiter;
      continue;
    }
    if (codeDelimiter || text[match.index - 1] === "!") continue;
    const id = parseSubagentLink(match[3]!);
    if (!id) continue;
    if (literalStart < match.index) parts.push({ text: text.slice(literalStart, match.index) });
    parts.push({ id, label: match[2]! });
    literalStart = match.index + match[0].length;
  }
  if (literalStart < text.length) parts.push({ text: text.slice(literalStart) });
  return parts;
}
