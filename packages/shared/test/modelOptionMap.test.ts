import assert from "node:assert/strict";
import test from "node:test";
import { compileModelOptionMap } from "../src/model-option-map/compiler.js";
import { completeEnumOptionSpecDataSchema } from "../src/model-config.js";

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

test("model option maps keep conditional object evaluation and frozen results", () => {
  const program = compileModelOptionMap(
    'reasoningLevel == "off" ? {} : {"thinking": {"level": reasoningLevel}}',
    "reasoningLevel",
  );
  assert.deepEqual(plain(program.evaluate("off")), {});
  assert.deepEqual(plain(program.evaluate("high")), { thinking: { level: "high" } });
  assert.ok(Object.isFrozen(program));
  assert.ok(Object.isFrozen(program.evaluate("high").thinking));
});

test("model option maps preserve numeric arithmetic and JSON-safe limits", () => {
  const program = compileModelOptionMap('{"max_tokens": maxOutputTokens / 2}', "maxOutputTokens");
  assert.deepEqual(plain(program.evaluate(2048)), { max_tokens: 1024 });
  assert.throws(() => program.evaluate(Infinity), /JSON-safe/);
  assert.throws(
    () => compileModelOptionMap('{"n": 9007199254740992}', "maxOutputTokens"),
    /JSON-safe/,
  );
});

test("model option maps reject non-object branches and unknown/call/member expressions", () => {
  for (const source of [
    "",
    "reasoningLevel",
    'reasoningLevel == "off" ? {} : 1',
    '{"level": unknown}',
    '{"level": reasoningLevel.value}',
    '{"level": value()}',
    '{"duplicate": 1, "duplicate": 2}',
  ]) {
    assert.throws(() => compileModelOptionMap(source, "reasoningLevel"));
  }
});

test("live model option schema still validates maps with the shared compiler", () => {
  assert.ok(completeEnumOptionSpecDataSchema.safeParse({ values: ["off"], map: "{}" }).success);
  assert.equal(
    completeEnumOptionSpecDataSchema.safeParse({ values: ["off"], map: "1" }).success,
    false,
  );
});

test("bounded compiler cache preserves evaluation after eviction", () => {
  const program = compileModelOptionMap('{"first": reasoningLevel}', "reasoningLevel");
  for (let i = 0; i < 256; i += 1) {
    compileModelOptionMap(`{"n": ${i}, "level": reasoningLevel}`, "reasoningLevel");
  }
  assert.deepEqual(plain(program.evaluate("high")), { first: "high" });
  assert.deepEqual(plain(compileModelOptionMap(program.source, "reasoningLevel").evaluate("off")), {
    first: "off",
  });
});
