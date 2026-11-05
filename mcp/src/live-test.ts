// Live regression test: drives the MCP server (dist/index.js) like an agent against a logged-on SAP GUI
// with the bridge. Uses standard objects only and saves nothing; works in the agent's own session.
//
//   npm run test:live -- --system A4H/001 [--abap-program ZPROG]
//
//   --system        SID/client of a logged-on SAP GUI with the bridge (required when several run)
//   --abap-program  optional: a program of your own (in $TMP) for the ABAP editor change-mode test –
//                   a line is inserted, Check runs, the editor is left with "No" (nothing saved, the
//                   program is never executed). Without it that step is skipped.
//
// Exit code 0 = all steps passed. Not part of `npm test` / CI (needs a running SAP GUI).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const system = opt("system");
const abapProgram = opt("abap-program")?.toUpperCase();
const version = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version as string;

type Result = { text: string; isError: boolean; images: number };
const client = new Client({ name: "sapgui-java-live-test", version });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, "index.js")], env: process.env as Record<string, string> }));

const log: string[] = [];
async function tool(name: string, a: Record<string, unknown> = {}): Promise<Result> {
  const r: any = await client.callTool({ name, arguments: { ...(system ? { system } : {}), ...a } });
  const text = r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  log.push(`--- ${name} ${JSON.stringify(a)}${r.isError ? " (isError)" : ""}\n${text}`);
  return { text, isError: !!r.isError, images: r.content.filter((c: any) => c.type === "image").length };
}

class Fail extends Error {}
function check(cond: unknown, what: string, r?: Result): asserts cond {
  if (!cond) throw new Fail(what + (r ? `\n    got: ${r.text.split("\n").slice(0, 6).join("\n         ")}` : ""));
}
const ok = (r: Result, what: string) => check(!r.isError, `${what} failed`, r);
const refused = (r: Result, pattern: RegExp, what: string) => check(r.isError && pattern.test(r.text), `${what} should be refused (${pattern})`, r);

// id of the first control of a type in a compact/full screen: "container/\n  shell Shell control=X"
function controlId(screen: string, control: string): string | undefined {
  let container = "";
  for (const line of screen.split("\n")) {
    if (/^\S.*\/$/.test(line)) container = line.trim();
    const m = /^\s+(\S+) .*control=(\w+)/.exec(line);
    if (m && m[2] === control) return container + m[1];
    const f = /^\s*(\S+)\s+Shell\s.*control=(\w+)/.exec(line);       // view=full: absolute id first
    if (f && f[2] === control && f[1].startsWith("wnd[")) return f[1];
  }
  return undefined;
}
async function findControl(control: string): Promise<string> {
  const s = await tool("sap_screen", { view: "compact" });
  const id = controlId(s.text, control);
  check(id, `no ${control} on the screen`, s);
  return id;
}
const header = (r: Result) => r.text.split("\n").find(l => / \| .* \| active wnd/.test(l)) ?? "";

const steps: [string, () => Promise<string | void>][] = [];
const step = (name: string, fn: () => Promise<string | void>) => steps.push([name, fn]);

// ------------------------------------------------------------------ steps
step("status: bridge version matches the MCP server", async () => {
  const r = await tool("sap_status");
  ok(r, "sap_status");
  const v = [...r.text.matchAll(/bridge (\d+\.\d+\.\d+)/g)].map(m => m[1]);
  check(v.length > 0, "no bridge found", r);
  check(v.every(x => x === version), `bridge versions ${[...new Set(v)].join(", ")} ≠ MCP server ${version} – reload with sap_reload_bridge`, r);
  return `${v.length} bridge(s) ${version}`;
});

let tree = "";
step("Easy Access tree: read, node context menu, write gate", async () => {
  // "/n" ends the current transaction and shows SAP Easy Access (SESSION_MANAGER cannot be started
  // as a transaction from every screen – "Cannot start transaction SESSION_MANAGER" from SE38)
  const n = await tool("sap_send_command", { command: "/n", view: "compact" });
  ok(n, "/n");
  // some systems show the start screen S000 first ("Start SAP Easy Access" button)
  if (/btnSTARTBUTTON/.test(n.text)) ok(await tool("sap_press", { id: "wnd[0]/usr/btnSTARTBUTTON", view: "status" }), "Start SAP Easy Access");
  tree = await findControl("SapTreeWrapper");
  const t = await tool("sap_read_tree", { id: tree, maxNodes: 50 });
  ok(t, "sap_read_tree");
  check(/^Favo\t/m.test(t.text), "no Favorites node (Favo)", t);
  const m = await tool("sap_tree_action", { id: tree, action: "nodeContextMenu", node: "Favo", view: "status" });
  ok(m, "nodeContextMenu");
  check(/context menu \(\d+ entries/.test(m.text) && /XXDELF\t/.test(m.text), "menu without XXDELF (Delete All Favorites)", m);
  ok(await tool("sap_tree_action", { id: tree, action: "closeContextMenu", view: "status" }), "closeContextMenu");
  refused(await tool("sap_tree_action", { id: tree, action: "nodeContextMenu", node: "Favo", menuItem: "XXDELF", view: "status" }),
    /write gate/, "Delete All Favorites");
  const after = await tool("sap_read_tree", { id: tree, maxNodes: 50 });
  check(after.text.split("\n").length === t.text.split("\n").length, "favorites changed after the refused delete", after);
  refused(await tool("sap_tree_action", { id: tree, action: "selectContextMenuItem", menuItem: "XXEXPD", view: "status" }),
    /no context menu is open/, "select with the menu closed");
});

step("screen guard and write gate", async () => {
  refused(await tool("sap_send_key", { key: "Enter", expect: "SAPLNOPE/999", view: "status" }), /screen guard/, "Enter with a wrong expect");
  refused(await tool("sap_send_key", { key: "Save", view: "status" }), /write gate/, "Save without confirm");
  refused(await tool("sap_press", { id: "wnd[0]/tbar[0]/btn[11]", view: "status" }), /write gate/, "Save button without confirm");
});

step("table display: ALV grid, context menu", async () => {
  let s: Result | undefined;
  for (const tc of ["SE16H", "S416H"]) {
    s = await tool("sap_start_transaction", { tcode: tc, view: "compact" });
    if (!s.isError && /ctxtGD-TAB/.test(s.text)) break;
    s = undefined;
  }
  check(s, "neither SE16H nor S416H available");
  ok(await tool("sap_set_fields", { fields: [{ id: "wnd[0]/usr/ctxtGD-TAB", value: "T000" }], then: "F8", view: "status" }), "T000 + F8");
  const grid = await findControl("SapGridWrapper");
  const g = await tool("sap_read_grid", { id: grid, maxRows: 5 });
  ok(g, "sap_read_grid");
  check(/\bMANDT\b/.test(g.text) && /^000\t/m.test(g.text), "T000 grid without client 000", g);
  const m = await tool("sap_grid_action", { id: grid, action: "contextMenu", row: 0, column: "MANDT", view: "status" });
  ok(m, "grid contextMenu");
  check(/&OPTIMIZE\t/.test(m.text), "grid menu without &OPTIMIZE", m);
  const sel = await tool("sap_grid_action", { id: grid, action: "selectContextMenuItem", menuItem: "&OPTIMIZE", view: "status" });
  ok(sel, "select &OPTIMIZE");
  check(/selected &OPTIMIZE/.test(sel.text), "not selected", sel);
  refused(await tool("sap_grid_action", { id: grid, action: "contextMenu", row: 0, column: "MANDT", menuItem: "&NOPE", view: "status" }),
    /no entry &NOPE/, "unknown menu code");
  const disabled = /^\s+(\S+)\t.*\(disabled/m.exec(m.text);
  if (disabled) refused(await tool("sap_grid_action", { id: grid, action: "contextMenu", row: 0, column: "MANDT", menuItem: disabled[1], view: "status" }),
    /is disabled/, `disabled entry ${disabled[1]}`);
  return disabled ? `disabled entry ${disabled[1]} refused` : "no disabled entry to test";
});

step("ABAP editor (display): read, write refused; keys bound to Delete gated", async () => {
  ok(await tool("sap_start_transaction", { tcode: "SE38", view: "status" }), "SE38");
  // Shift+F2 on the SE38 initial screen is "Delete..." – the gate reads what the key is bound to
  refused(await tool("sap_send_key", { key: "Shift+F2", view: "status" }), /write gate: vkey 14 = /, "Shift+F2 (Delete...)");
  ok(await tool("sap_send_key", { key: "Enter", view: "status" }), "Enter stays free");
  const d = await tool("sap_set_fields", { fields: [{ id: "wnd[0]/usr/ctxtRS38M-PROGRAMM", value: "RSPARAM" }], then: { press: "wnd[0]/usr/btnSHOP" }, view: "compact" });
  ok(d, "display RSPARAM");
  const ed = controlId(d.text, "SapAbapEditorWrapper");
  check(ed, "no ABAP editor", d);
  check(/lines=\d+ ro/.test(d.text), "editor not shown as lines=N ro", d);
  const t = await tool("sap_read_text", { id: ed, maxLines: 400 });
  ok(t, "sap_read_text");
  check(/\(read-only\)/.test(t.text) && /^\s*\d+\| REPORT rsparam/im.test(t.text), "no REPORT line / not read-only", t);
  refused(await tool("sap_set_text", { id: ed, fromLine: 1, text: "* x", view: "status" }), /read-only/, "set_text in display mode");
  ok(await tool("sap_send_key", { key: "Back", view: "status" }), "Back");
});

step("ABAP editor (change mode, --abap-program): insert, Check, leave without saving", async () => {
  if (!abapProgram) return "skipped (no --abap-program)";
  ok(await tool("sap_start_transaction", { tcode: "SE38", view: "status" }), "SE38");
  const c = await tool("sap_set_fields", { fields: [{ id: "wnd[0]/usr/ctxtRS38M-PROGRAMM", value: abapProgram }], then: { press: "wnd[0]/usr/btnCHAP" }, view: "compact" });
  ok(c, `change ${abapProgram}`);
  check(/lines=\d+ editable/.test(c.text), "editor not in change mode (pop-up, lock or original language?)", c);
  const ed = controlId(c.text, "SapAbapEditorWrapper")!;
  // Program > Save in the menu bar: gated by its accelerator (Ctrl+S), whatever the logon language
  refused(await tool("sap_press", { id: "wnd[0]/mbar/menu[0]/menu[6]", view: "status" }), /write gate: .*\(Ctrl\+S\)/, "menu Program > Save");
  const n = Number(/lines=(\d+)/.exec(c.text)![1]);
  const ins = await tool("sap_set_text", { id: ed, insertBefore: n + 1, text: "WRITE zz_no_such_variable_4711.", view: "status" });
  ok(ins, "insert line");
  check(new RegExp(`now has ${n + 1} lines`).test(ins.text), "line count after insert", ins);
  const chk = await tool("sap_press", { id: "wnd[0]/tbar[1]/btn[26]", view: "compact" });
  ok(chk, "Check");
  const errs = controlId(chk.text, "SapGridWrapper");
  check(errs, "no error list after Check", chk);
  const g = await tool("sap_read_grid", { id: errs });
  check(/ZZ_NO_SUCH_VARIABLE_4711/i.test(g.text) && new RegExp(`\\b${n + 1}\\b`).test(g.text), "error list without the inserted line", g);
  const back = await tool("sap_send_key", { key: "Back", view: "status" });
  const no = /"No"=([^,\s]+)/.exec(back.text);
  check(no, "no save question when leaving", back);
  const left = await tool("sap_press", { id: no[1], view: "status" });
  ok(left, "answer No");
  check(/SAPLWBABAP\/100/.test(header(left)), "not back on the SE38 initial screen", left);
});

// SAP's TextEdit demo SAPTEXTEDIT_DEMO_1: only shows the control (no database access). SO00 was used
// first, but every start of SO00 creates an empty draft document (SOOD) – not save-free.
step("text editor (SAPTEXTEDIT_DEMO_1): replace, insert, read, range check", async () => {
  ok(await tool("sap_start_transaction", { tcode: "SE38", view: "status" }), "SE38");
  const s = await tool("sap_set_fields", { fields: [{ id: "wnd[0]/usr/ctxtRS38M-PROGRAMM", value: "SAPTEXTEDIT_DEMO_1" }], then: "F8", view: "compact" });
  ok(s, "run SAPTEXTEDIT_DEMO_1");
  const ed = controlId(s.text, "SapTextEditWrapper");
  check(ed, "no TextEdit in SAPTEXTEDIT_DEMO_1", s);
  ok(await tool("sap_set_text", { id: ed, text: "line one\nline two", view: "status" }), "replace all");
  ok(await tool("sap_set_text", { id: ed, insertBefore: 2, text: "inserted – äöü", view: "status" }), "insert");
  ok(await tool("sap_set_text", { id: ed, fromLine: 3, text: "LINE THREE", view: "status" }), "replace line");
  const t = await tool("sap_read_text", { id: ed });
  check(/1\| line one\n2\| inserted – äöü\n3\| LINE THREE/.test(t.text) && /modified/.test(t.text), "unexpected text", t);
  refused(await tool("sap_set_text", { id: ed, fromLine: 9, text: "x", view: "status" }), /fromLine\/toLine must lie in 1\.\.3/, "line out of range");
  ok(await tool("sap_send_key", { key: "Back", view: "status" }), "Back");
});

step("agent session ended by SAP (/i): reported, next call gets a new one", async () => {
  ok(await tool("sap_start_transaction", { tcode: "SE38", view: "status" }), "SE38");
  const before = /(\S*ses\[\d+\]) \|/.exec(header(await tool("sap_screen", { view: "status" })))?.[1];
  refused(await tool("sap_send_command", { command: "/i", view: "status" }), /session was closed by this action/, "/i");
  const s = await tool("sap_screen", { view: "status" });
  ok(s, "screen after the session ended");
  const now = /(\S*ses\[\d+\]) \|/.exec(header(s))?.[1];
  check(now, "no session in the header", s);
  return `${before} ended, now ${now}`;
});

step("screenshot", async () => {
  const r = await tool("sap_screenshot");
  ok(r, "sap_screenshot");
  check(r.images === 1, "no image content", r);
});

// ------------------------------------------------------------------ run
let failed = 0;
for (const [name, fn] of steps) {
  const t0 = Date.now();
  try {
    const note = await fn();
    console.log(`PASS  ${name}${note ? ` – ${note}` : ""} (${Date.now() - t0} ms)`);
  } catch (e: any) {
    failed++;
    console.log(`FAIL  ${name}\n    ${e instanceof Fail ? e.message : e?.stack ?? e}`);
    try { await tool("sap_send_key", { key: "Cancel", view: "status" }); } catch { /* best effort */ }
  }
}
try { await tool("sap_close_session"); } catch { /* the session may already be gone */ }
await client.close();
if (failed && process.env.LIVE_LOG !== "0") console.log(`\ncall log:\n${log.join("\n").slice(-6000)}`);
console.log(`\n${steps.length - failed} of ${steps.length} steps passed`);
process.exit(failed ? 1 : 0);
