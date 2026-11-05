import { test } from "node:test";
import assert from "node:assert/strict";
import { formatList } from "../dist/format.js";

const cell = (col, row, text, type = "Label") => ({ col, text, type, id: `wnd[0]/usr/lbl[${col},${row}]` });
const list = {
  window: "wnd[0]", title: "Data Browser", cells: 0, scrollbar: { position: 0, maximum: 100, pageSize: 20 },
  session: { system: "DEV", client: "100", id: "/app/con[0]/ses[1]", ref: "con[0]/ses[1]", transaction: "SE16", program: "SAPMSSY0", screen: 120 },
  rows: [
    { row: 0, cells: [cell(0, 0, "Table:"), cell(16, 0, "T000")] },
    { row: 1, cells: [cell(0, 1, "Displayed Fields:"), cell(19, 1, "17"), cell(22, 1, "of")] },
    { row: 3, cells: [cell(3, 3, "MANDT"), cell(9, 3, "MTEXT"), cell(35, 3, "ORT01")] },
    { row: 5, cells: [cell(3, 5, "000"), cell(9, 5, "SAP SE"), cell(35, 5, "Walldorf")] },
    { row: 6, cells: [cell(3, 6, "001"), cell(9, 6, "Demo")] },
  ],
};

test("title lines become text, header and data share columns", () => {
  const out = formatList(list).split("\n");
  assert.ok(out.includes("line\t@3\t@9\t@35"), out.join("\n"));
  assert.ok(out.includes("0\tTable: T000"));
  assert.ok(out.includes("3\tMANDT\tMTEXT\tORT01"));
  assert.ok(out.includes("6\t001\tDemo\t"));
});
test("columns come from the whole page even when only a slice is shown", () => {
  const out = formatList(list, 5, 1).split("\n");
  assert.ok(out.includes("line\t@3\t@9\t@35"));
  assert.ok(out.includes("5\t000\tSAP SE\tWalldorf"));
  assert.ok(!out.some(l => l.startsWith("6\t")));
});
test("more pages are announced", () => {
  assert.match(formatList(list), /more lines below \(scroll 0\/100, page 20\)/);
});
