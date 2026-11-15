import assert from "node:assert/strict";
import test from "node:test";
import { NekHistoryAnchorCache } from "../src/nek-agent/projection/nekHistoryAnchorCache.js";
import { buildToolCallRow } from "../src/nek-agent/projection/nekRows.js";

test("HS6: seed cache retains six pages at most and never caches completed output bodies", () => {
  const cache = new NekHistoryAnchorCache();
  for (let index = 0; index < 7; index++)
    cache.remember(String(index), String(index), [
      buildToolCallRow(
        { rowId: index + 1, entityId: `tool:${index}`, turnId: "t", createdAt: 1 },
        {
          toolCallId: String(index),
          toolName: "read",
          status: "success",
          input: { path: "file" },
          output: { text: "large body".repeat(100) },
        },
      ),
    ]);
  assert.equal(cache.read("0").length, 0);
  const retained = cache.read("6")[0];
  assert.equal(retained?.kind === "toolCall" && retained.output, undefined);
  cache.clear();
  assert.equal(cache.read("6").length, 0);
});
