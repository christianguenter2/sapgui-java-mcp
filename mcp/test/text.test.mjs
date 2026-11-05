import { test } from "node:test";
import assert from "node:assert/strict";
import { formatText } from "../dist/format.js";

const base = { id: "wnd[0]/usr/cntlEDITOR/shellcont/shell", editor: "abap", modified: false };

test("numbered lines, padded to the widest number, with a hint for more", () => {
  const out = formatText({ ...base, lineCount: 120, firstLine: 9, lines: ["REPORT z.", "", "WRITE 1."], changeable: true }).split("\n");
  assert.equal(out[0], "ABAP editor wnd[0]/usr/cntlEDITOR/shellcont/shell: lines 9..11 of 120 (editable)");
  assert.deepEqual(out.slice(1, 4), [" 9| REPORT z.", "10| ", "11| WRITE 1."]);
  assert.equal(out[4], "… more lines: call again with firstLine=12");
});

test("read-only / modified state, text editor, no hint at the end", () => {
  const out = formatText({ ...base, editor: "text", lineCount: 2, firstLine: 1, lines: ["a", "b"], changeable: false, modified: true }).split("\n");
  assert.match(out[0], /^text editor .*: lines 1\.\.2 of 2 \(read-only, modified\)$/);
  assert.equal(out.length, 3);
});

test("past the end", () => {
  assert.match(formatText({ ...base, lineCount: 3, firstLine: 10, lines: [] }), /lines none of 3$/);
});
