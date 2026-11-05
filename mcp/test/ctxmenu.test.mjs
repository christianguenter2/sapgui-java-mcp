import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCtxMenu } from "../dist/format.js";

const items = [
  { code: "&DETAIL", text: "Details", path: "Details", level: 0, enabled: true },
  { code: "", text: "Export", path: "Export", level: 0, enabled: true, submenu: true },
  { code: "&XXL", text: "Spreadsheet", path: "Export > Spreadsheet", level: 1, enabled: false },
  { code: "&SUM", text: "Totals", path: "Totals", level: 0, enabled: true, checked: true },
];

test("open menu lists codes, submenus and flags, indented by level", () => {
  const out = formatCtxMenu({ contextMenu: items }).split("\n");
  assert.match(out[1], /context menu \(3 entries/);
  assert.equal(out[2], "  &DETAIL\tDetails");
  assert.equal(out[3], "  Export >");
  assert.equal(out[4], "    &XXL\tSpreadsheet (disabled)");
  assert.equal(out[5], "  &SUM\tTotals (checked)");
});

test("selected entry and note are one-liners; nothing to say gives empty", () => {
  assert.equal(formatCtxMenu({ selected: { code: "&DETAIL", text: "Details" } }), ' – selected &DETAIL "Details"');
  assert.equal(formatCtxMenu({ note: "no context menu appeared" }), " – no context menu appeared");
  assert.equal(formatCtxMenu({}), "");
  assert.match(formatCtxMenu({ contextMenu: [] }), /open but empty/);
});
