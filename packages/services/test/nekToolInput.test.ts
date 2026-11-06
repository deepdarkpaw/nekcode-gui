import assert from "node:assert/strict";
import test from "node:test";
import { appendToolArgument } from "../src/nek-agent/projection/nekToolInput.js";

test("field deltas update nested strings immutably and reject inherited or invalid paths", () => {
  const input = { edits: [{ newText: "one" }] };
  assert.deepEqual(appendToolArgument(input, ["edits", 0, "newText"], "\ntwo"), {
    edits: [{ newText: "one\ntwo" }],
  });
  assert.deepEqual(input, { edits: [{ newText: "one" }] });
  assert.throws(
    () => appendToolArgument({}, ["constructor", "prototype", "polluted"], "x"),
    /Missing/,
  );
  assert.throws(() => appendToolArgument(input, ["edits", 99999], "x"), /array index/);
  assert.throws(() => appendToolArgument(input, [], "x"), /path/);
  const safe = appendToolArgument({}, ["__proto__"], "data") as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(safe), Object.prototype);
  assert.equal(Object.hasOwn(safe, "__proto__"), true);
  assert.equal(safe.__proto__, "data");
});
