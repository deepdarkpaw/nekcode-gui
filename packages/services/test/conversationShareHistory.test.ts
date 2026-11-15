import assert from "node:assert/strict";
import test from "node:test";
import { exportedRows, historyFixture, target, turnId } from "./conversationShareHistoryFixture.js";

test("SH1/SH3/SH6: explicitly chosen old turn exports from source, not the renderer's latest20 projection", async () => {
  const h = historyFixture();
  const before = JSON.stringify(h.rows);
  const selected = { kind: "productTurns" as const, productTurnIds: [turnId(2)] };
  const preflight = await h.service.preflight({ ...target, selection: selected });
  assert.deepEqual(preflight.blockingIssues, []);
  assert.deepEqual(
    preflight.turnResults.map((turn) => turn.productTurnId),
    [turnId(2)],
  );
  const content = await exportedRows(h.service, selected);
  assert.deepEqual(
    content.rows.filter((row) => row.kind === "userInput").map((row) => row.text),
    ["Question 3"],
  );
  assert.deepEqual(
    h.calls.map((call) => call.method),
    Array(8).fill("page"),
  );
  assert.equal(
    JSON.stringify(h.rows),
    before,
    "source/renderer rows were not rewritten or merged in place",
  );
});

test("SH2/SH6: explicit all export pages all 70 source turns as 20/20/20/10, never treats tail20 as complete", async () => {
  const h = historyFixture();
  const content = await exportedRows(h.service, { kind: "all" });
  assert.equal(content.rows.filter((row) => row.kind === "turnHeader").length, 70);
  assert.deepEqual(
    content.rows.filter((row) => row.kind === "userInput").map((row) => row.text),
    Array.from({ length: 70 }, (_, index) => `Question ${index + 1}`),
  );
  assert.deepEqual(
    h.calls.map((call) => [call.method, call.input.beforeCursor]),
    [
      ["page", undefined],
      ["page", "older:50"],
      ["page", "older:30"],
      ["page", "older:10"],
    ],
  );
});
