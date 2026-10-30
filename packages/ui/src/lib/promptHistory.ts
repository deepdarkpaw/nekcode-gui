export const MAX_PROMPT_HISTORY = 30;
export const MAX_PROMPT_HISTORY_ENTRY_BYTES = 64 * 1024;

function truncatePromptHistoryEntry(entry: string): string {
  const encoded = new TextEncoder().encode(entry);
  if (encoded.byteLength <= MAX_PROMPT_HISTORY_ENTRY_BYTES) return entry;
  let low = 0;
  let high = entry.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      new TextEncoder().encode(entry.slice(0, middle)).byteLength <= MAX_PROMPT_HISTORY_ENTRY_BYTES
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return entry.slice(0, low);
}

type PromptHistoryDirection = "up" | "down";

export function shouldHandlePromptHistoryNavigation(input: {
  text: string;
  atEditorStart: boolean;
  currentIndex: number | null;
}): boolean {
  return input.currentIndex !== null || input.text.length === 0 || input.atEditorStart;
}

interface PromptHistoryNavigationResult {
  nextIndex: number | null;
  nextValue: string;
  shouldHandle: boolean;
}

export function appendPromptHistoryEntry(
  entries: readonly string[],
  entry: string,
  limit = MAX_PROMPT_HISTORY,
): string[] {
  const trimmed = truncatePromptHistoryEntry(entry.trim());
  if (!trimmed) {
    return [...entries];
  }

  // 之前每次提交都会直接追加，连续发送相同 prompt 会让上键重复命中同一条。
  // 这里只比较 trim 后的最后一条，避免误删 A、B、A 这类非连续重复历史。
  if (entries.at(-1)?.trim() === trimmed) {
    return [...entries];
  }

  const normalizedLimit = Math.max(1, Math.trunc(limit));
  return [...entries, trimmed].slice(-normalizedLimit);
}

export function navigatePromptHistory(
  entries: readonly string[],
  currentIndex: number | null,
  direction: PromptHistoryDirection,
): PromptHistoryNavigationResult {
  if (entries.length === 0) {
    return {
      nextIndex: currentIndex,
      nextValue: "",
      shouldHandle: false,
    };
  }

  if (direction === "up") {
    const nextIndex = currentIndex === null ? entries.length - 1 : Math.max(currentIndex - 1, 0);
    return {
      nextIndex,
      nextValue: entries[nextIndex] ?? "",
      shouldHandle: true,
    };
  }

  if (currentIndex === null) {
    return {
      nextIndex: null,
      nextValue: "",
      shouldHandle: false,
    };
  }

  if (currentIndex >= entries.length - 1) {
    return {
      nextIndex: null,
      nextValue: "",
      shouldHandle: true,
    };
  }

  const nextIndex = currentIndex + 1;
  return {
    nextIndex,
    nextValue: entries[nextIndex] ?? "",
    shouldHandle: true,
  };
}
