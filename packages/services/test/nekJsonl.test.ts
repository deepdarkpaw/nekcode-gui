import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  attachNekJsonlReader,
  NekJsonlDecoder,
  NekJsonlLineTooLongError,
  NEK_JSONL_MAX_LINE_BYTES,
  serializeNekJsonLine,
} from "../src/nek-agent/jsonl.js";

/**
 * 分帧是整条链路的基座：错一个字节，后面所有命令关联都会错位。
 * 覆盖：只按 LF 断行（U+2028/U+2029 不断行）、CRLF 容忍、跨块 UTF-8、单行上限。
 */

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

function createDecoder(maxLineBytes?: number) {
  const lines: string[] = [];
  const overflows: NekJsonlLineTooLongError[] = [];
  const decoder = new NekJsonlDecoder({
    maxLineBytes,
    onLine: (line) => lines.push(line),
    onLineTooLong: (error) => overflows.push(error),
  });
  return { decoder, lines, overflows };
}

test("serializeNekJsonLine writes exactly one LF-terminated record", () => {
  assert.equal(
    serializeNekJsonLine({ type: "get_state", id: "1" }),
    '{"type":"get_state","id":"1"}\n',
  );
  const line = serializeNekJsonLine({ text: `a${LS}b${PS}c` });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.split("\n").length, 2);
});

test("decoder splits only on LF and keeps U+2028/U+2029 inside a record", () => {
  const { decoder, lines } = createDecoder();
  const first = JSON.stringify({ text: `a${LS}b${PS}c` });
  decoder.write(`${first}\n{"text":"second"}\n`);
  assert.deepEqual(lines, [first, '{"text":"second"}']);
});

test("decoder tolerates CRLF and multi-chunk records", () => {
  const { decoder, lines } = createDecoder();
  decoder.write('{"a":');
  decoder.write("1}\r\n");
  decoder.write('{"b":2}\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("decoder decodes UTF-8 sequences split across chunks", () => {
  const { decoder, lines } = createDecoder();
  const payload = serializeNekJsonLine({ text: "中文" });
  const bytes = Buffer.from(payload, "utf8");
  // 在多字节字符中间切块：StringDecoder 必须把半个字符留到下一块。
  const cut = bytes.indexOf(Buffer.from("中", "utf8")) + 1;
  decoder.write(bytes.subarray(0, cut));
  decoder.write(bytes.subarray(cut));
  assert.deepEqual(lines, [JSON.stringify({ text: "中文" })]);
});

test("decoder flushes a trailing record without LF on end()", () => {
  const { decoder, lines } = createDecoder();
  decoder.write('{"a":1}');
  decoder.end();
  assert.deepEqual(lines, ['{"a":1}']);
});

test("decoder reports a record above the byte ceiling and resyncs on the next LF", () => {
  const { decoder, lines, overflows } = createDecoder(16);
  decoder.write('{"big":"xxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n{"ok":true}\n');
  assert.equal(overflows.length, 1);
  assert.equal(overflows[0]?.maxBytes, 16);
  assert.ok((overflows[0]?.bytes ?? 0) > 16);
  // 超限记录被丢弃，但后续记录照常投递（不静默截断成半个对象）。
  assert.deepEqual(lines, ['{"ok":true}']);
});

test("default ceiling is 64 MB", () => {
  assert.equal(NEK_JSONL_MAX_LINE_BYTES, 64 * 1024 * 1024);
});

test("attachNekJsonlReader parses records, skips blanks and reports bad JSON", async () => {
  const stream = new PassThrough();
  const records: unknown[] = [];
  const errors: string[] = [];
  attachNekJsonlReader(stream, {
    onRecord: (record) => records.push(record),
    onParseError: (error) => errors.push(error.message),
  });
  stream.write('\n{"type":"agent_start"}\n');
  stream.write("{not json}\n");
  const last = JSON.stringify({ type: "agent_settled", note: `a${LS}b` });
  stream.end(`${last}\n`);
  await new Promise((resolve) => stream.once("end", resolve));
  assert.deepEqual(records, [{ type: "agent_start" }, { type: "agent_settled", note: `a${LS}b` }]);
  assert.equal(errors.length, 1);
});
