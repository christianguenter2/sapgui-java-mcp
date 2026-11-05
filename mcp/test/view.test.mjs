import { test } from "node:test";
import assert from "node:assert/strict";
import { lastPart, parentOf, renderScreen } from "../dist/view.js";

test("id splitting: plain ids", () => {
  assert.equal(parentOf("wnd[0]/usr/ctxtGD-TAB"), "wnd[0]/usr");
  assert.equal(lastPart("wnd[0]/usr/ctxtGD-TAB"), "ctxtGD-TAB");
  assert.equal(lastPart("wnd[0]/tbar[0]/btn[11]"), "btn[11]");
});
test("id splitting: namespace slashes stay inside the segment", () => {
  const id = "wnd[0]/usr/tbl/XYZ/SAPLCFG_VTCTRL_/XYZ/CFG_V/txt/XYZ/CFG_V-NAME[0,0]";
  assert.equal(parentOf(id), "wnd[0]/usr/tbl/XYZ/SAPLCFG_VTCTRL_/XYZ/CFG_V");
  assert.equal(lastPart(id), "txt/XYZ/CFG_V-NAME[0,0]");
  assert.equal(parentOf("wnd[0]/usr/ssubSUB:/XYZ/SAPLFOO:0400/txtF-/XYZ/FIELD"), "wnd[0]/usr/ssubSUB:/XYZ/SAPLFOO:0400");
});

const screen = (els, extra = {}) => ({
  session: { id: "/app/con[0]/ses[1]", ref: "con[0]/ses[1]", system: "DEV", client: "100", user: "U", transaction: "SE16H", program: "SAPLSE16N", screen: 120 },
  activeWindow: "wnd[0]", windows: [{ id: "wnd[0]", type: "GuiMainWindow", title: "General Table Display" }],
  statusBar: { type: "S", text: "ok", id: "XX", number: "001" }, truncated: false, elements: els, ...extra,
});
const base = [
  { id: "wnd[0]/tbar[0]/btn[0]", type: "GuiButton", tooltip: "Enter" },
  { id: "wnd[0]/tbar[0]/btn[11]", type: "GuiButton", tooltip: "Save" },
  { id: "wnd[0]/tbar[0]/btn[71]", type: "GuiButton", tooltip: "Find" },
  { id: "wnd[0]/tbar[0]/okcd", type: "GuiOKCodeField", text: "", changeable: true },
  { id: "wnd[0]/usr/lblGD-TAB", type: "GuiLabel", text: "Table" },
  { id: "wnd[0]/usr/ctxtGD-TAB", type: "GuiCTextField", text: "T000", changeable: true, required: true },
  { id: "wnd[0]/usr/txtEMPTY", type: "GuiTextField", text: "", changeable: false },
];

test("compact: toolbar on one line, label merged, OK-code and empty read-only fields dropped", () => {
  const out = renderScreen(screen(base), "compact");
  assert.match(out, /wnd\[0\]\/tbar\[0\]: btn\[0\]=Enter, btn\[11\]=Save \(\+1 standard\)/);
  assert.match(out, /ctxtGD-TAB ="T000" req "Table"/);
  assert.doesNotMatch(out, /okcd|txtEMPTY|lblGD-TAB/);
});
test("changed: only the element that changed", () => {
  renderScreen(screen(base), "compact");   // remembers this screen
  const next = base.map(e => e.id.endsWith("ctxtGD-TAB") ? { ...e, text: "T001" } : e);
  const out = renderScreen(screen(next), "changed");
  assert.match(out, /changed on this screen \(1 of/);
  assert.match(out, /ctxtGD-TAB ="T001"/);
  assert.doesNotMatch(out, /btn\[11\]/);
});
test("status: header, status bar and pop-up only", () => {
  const out = renderScreen(screen(base, { popup: { title: "Q", texts: ["Save changes?"], buttons: [{ id: "wnd[1]/usr/btnSPOP-OPTION1", text: "Yes" }] } }), "status");
  assert.match(out, /POPUP "Q"/);
  assert.match(out, /\| Save changes\?/);
  assert.doesNotMatch(out, /ctxtGD-TAB/);
});
