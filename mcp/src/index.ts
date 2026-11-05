#!/usr/bin/env node
// sapgui-java-mcp – MCP server for SAP GUI for Java (via scripts/bridge.js)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { call, readConfig, readInfo, BridgeError } from "./bridge.js";
import { formatGrid, formatTable, Screen, Grid, Table } from "./format.js";
import { renderScreen, View, VIEWS } from "./view.js";
import { userFormats, cachedFormats } from "./formats.js";

const server = new McpServer(
  { name: "sapgui-java", version: "0.1.0" },
  {
    instructions:
      "Drives a logged-on SAP GUI for Java session through its scripting API. " +
      "Workflow: sap_screen to see the current window (element ids like wnd[0]/usr/ctxtFIELD), " +
      "then sap_set_fields / sap_press / sap_send_key. Every action returns the resulting screen and status bar " +
      "(by default only what changed on the same screen, or a compact view of a new screen), so do not call " +
      "sap_screen again after an action; use view=full only when an element seems to be missing. Always read the status bar: [E] = error, [W] = warning, " +
      "[S] = success. Pop-ups appear as wnd[1], wnd[2]; their question and answer buttons are shown in a POPUP block – read it before answering, never guess. ALV grids and trees show up as control=SapGridWrapper / " +
      "SapTreeWrapper – read them with sap_read_grid / sap_read_tree; classic table controls (type TableControl) " +
      "with sap_read_table. Ask the user before saving data (Ctrl+S / " +
      "save buttons) or changing anything outside development/customizing tasks; the write gate enforces this: " +
      "Save/Post only run with confirm=true plus expect. Type amounts and dates in the user's formats (sap_user_formats, once per session). Pass expect (e.g. \"SAPLXYZ/200\", " +
      "copied from the last screen header) on every Save/Post and whenever the user may use the same session – " +
      "the action is then refused if the screen changed. Errors name the screen the session is on.",
  },
);

const session = z.string().optional().describe("Session path, default con[0]/ses[0]. See sap_status.");

type Content = { content: { type: "text"; text: string }[]; isError?: boolean };
const text = (t: string): Content => ({ content: [{ type: "text", text: t }] });

async function run(fn: () => Promise<string>): Promise<Content> {
  try { return text(await fn()); }
  catch (e: any) {
    const msg = e instanceof BridgeError ? e.message : `unexpected error: ${e?.message ?? e}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

const view = z.enum(VIEWS).optional().describe(
  "How much of the resulting screen to return: changed (default for actions – only what changed on the same " +
  "screen, compact when a new screen appears), compact, status (header/status/pop-up only) or full.");

// Screen guard: the action is refused (nothing done) if the session is not on this screen.
const expect = z.union([
  z.string().describe('Short form as in the screen header: "SAPLXYZ/200", optionally with transaction and window: "ZPOST SAPLXYZ/200 wnd[0]"'),
  z.object({
    program: z.string().optional(), screen: z.number().int().optional(),
    window: z.string().optional().describe("e.g. wnd[1]"), transaction: z.string().optional(),
  }),
]).optional().describe("Screen guard – refuse the action unless the session is on this screen. Use it for every write (Save/Post) and when the user may be working in the same session.");

const confirm = z.boolean().optional().describe(
  "Write gate: Save/Post (vkey 11, btn[11], Save/Post/Buchen buttons, OK-codes =BU/=SAVE …) are refused unless " +
  "confirm=true AND expect is given. Set it only after the user approved this specific save/post.");

type Expect = { program?: string; screen?: number; window?: string; transaction?: string };
function parseExpect(x: z.infer<typeof expect>): Expect | undefined {
  if (x === undefined) return undefined;
  if (typeof x !== "string") return x;
  const r: Expect = {};
  for (const tok of x.trim().split(/\s+/)) {
    const m = /^([A-Z0-9_\/]+)\/(\d+)$/i.exec(tok);
    if (m) { r.program = m[1]; r.screen = Number(m[2]); }
    else if (/^wnd\[\d+\]$/.test(tok)) r.window = tok;
    else if (tok) r.transaction = tok;
  }
  if (r.program === undefined && r.window === undefined && r.transaction === undefined)
    throw new BridgeError(`cannot parse expect ${JSON.stringify(x)} – use "PROGRAM/DYNPRO", e.g. "SAPLXYZ/200"`);
  return r;
}

function withScreen(head: string, r: { screen?: Screen }, v: View | undefined): string {
  return r.screen ? `${head}\n${renderScreen(r.screen, v ?? "changed")}` : head;
}

async function checkTcode(tcode: string) {
  const cfg = await readConfig();
  const t = tcode.replace(/^\/[nNoO]/, "").trim().toUpperCase();
  if (cfg.deniedTransactions.includes(t))
    throw new BridgeError(`transaction ${t} is denied by config.json (deniedTransactions)`);
}

const VKEYS: Record<string, number> = {
  Enter: 0, F1: 1, F2: 2, F3: 3, Back: 3, F4: 4, F5: 5, F6: 6, F7: 7, F8: 8, Execute: 8, F9: 9,
  F10: 10, F11: 11, Save: 11, F12: 12, Cancel: 12, "Shift+F3": 15, Exit: 15,
  "Ctrl+F": 71, Find: 71, PageUp: 81, PageDown: 82, "Ctrl+PageUp": 80, "Ctrl+PageDown": 83,
};

// ----------------------------------------------------------------- tools
server.registerTool("sap_status", {
  title: "SAP GUI status",
  description: "Bridge state, SAP GUI version, open connections and sessions (system, client, user, transaction, screen).",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => run(async () => {
  const s = await call("status");
  const lines = [`bridge ${s.bridge}, SAP GUI ${s.gui}`];
  for (const c of s.connections) {
    lines.push(`${c.id} ${JSON.stringify(c.description)} ${c.connectionString}${c.disabledByServer ? " – SCRIPTING DISABLED BY SERVER (reconnect after enabling)" : ""}`);
    for (const x of c.sessions) lines.push(x.error ? `  session error: ${x.error}` :
      `  ${x.id.replace(/^\/app\//, "")}: ${x.system}/${x.client} ${x.user} ${x.language} | ${x.transaction} ${x.program}/${x.screen}${x.readOnly ? " (read-only)" : ""}` +
      ((f) => f ? `\n    input formats: date ${f.date}, numbers ${f.decimal}, time ${f.time}` : "\n    input formats: unknown – call sap_user_formats")(cachedFormats(`${x.system}/${x.client}/${x.user}`)));
  }
  return lines.join("\n");
}));

server.registerTool("sap_user_formats", {
  title: "User input formats",
  description: "Date format, decimal notation and time format of the logged-on user (user defaults, SU3). " +
    "Opens SU3 in a separate session, reads the Defaults tab and closes that session again – the current session is not touched. " +
    "Cached per system/client/user; call it once before typing amounts or dates.",
  inputSchema: { session, refresh: z.boolean().optional().describe("Read again instead of using the cache") },
  annotations: { readOnlyHint: true },
}, async (a) => run(async () => {
  const f = await userFormats(a.session, a.refresh);
  return `${f.user}: date ${f.date}, numbers ${f.decimal}, time ${f.time}` +
    `${f.timeZone ? `, time zone ${f.timeZone}` : ""}${f.systemTimeZone ? ` (system ${f.systemTimeZone})` : ""}` +
    `\nraw USR01 keys: DATFM=${JSON.stringify(f.raw.datfm)} DCPFM=${JSON.stringify(f.raw.dcpfm)} TIMEFM=${JSON.stringify(f.raw.timefm)}` +
    `\ne.g. amount 2000.50 → ${f.decimal.startsWith("1.") ? "2000,50" : f.decimal.startsWith("1,") ? "2000.50" : "2000,50"}, ` +
    `date 30 June 2026 → ${f.date.replace("DD", "30").replace("MM", "06").replace("YYYY", "2026")}`;
}));

server.registerTool("sap_screen", {
  title: "Read current screen",
  description: "Current window of a session: title, status bar, and all fields/buttons/tabs/controls with ids, values and flags. Menus are omitted unless includeMenus.",
  inputSchema: {
    session,
    includeMenus: z.boolean().optional().describe("Include the menu bar tree (large)."),
    maxNodes: z.number().int().min(20).max(3000).optional().describe("Element limit, default 400."),
    view: z.enum(VIEWS).optional().describe("compact (default: toolbars in one line, labels merged, empty read-only fields omitted), changed, status or full"),
  },
  annotations: { readOnlyHint: true },
}, async (a) => run(async () => renderScreen(await call<Screen>("screen", a), a.view ?? "compact")));

server.registerTool("sap_start_transaction", {
  title: "Start transaction",
  description: "Start a transaction in the session (like /n<tcode>). Returns the new screen.",
  inputSchema: { tcode: z.string().min(1).describe("Transaction code, e.g. SE16N"), session, view },
}, async (a) => run(async () => {
  await checkTcode(a.tcode);
  return withScreen(`started ${a.tcode.toUpperCase()}`, await call("tcode", a), a.view);
}));

server.registerTool("sap_set_fields", {
  title: "Set field values",
  description: "Set one or more fields in order. Text fields take a string; checkboxes true/false; radio buttons are selected (value ignored); combo boxes take the key (or the visible value with by='value'). " +
    "Optional 'then': a key (e.g. \"Enter\", \"Execute\") or {press: id} sent after the fields – returns the resulting screen like sap_send_key/sap_press, saving a round trip. " +
    "Without 'then' nothing is sent and only the set values are returned.",
  inputSchema: {
    fields: z.array(z.object({
      id: z.string().describe("Element id from sap_screen, e.g. wnd[0]/usr/ctxtGD-TAB"),
      value: z.union([z.string(), z.boolean()]).optional(),
      by: z.enum(["key", "value"]).optional().describe("Combo boxes only."),
    })).min(1),
    then: z.union([
      z.enum(Object.keys(VKEYS) as [string, ...string[]]),
      z.object({ press: z.string().describe("Button/tab id to press after setting the fields") }),
    ]).optional().describe("Key or {press: id} to send after the fields (e.g. \"Enter\"). Save/F11 writes data – confirm with the user first."),
    session, expect, view, confirm,
  },
}, async (a) => run(async () => {
  const out: string[] = [];
  const ex = parseExpect(a.expect);
  for (const f of a.fields) {
    const r = await call("set", { session: a.session, id: f.id, value: f.value ?? "", by: f.by, expect: ex });
    out.push(`${r.id} (${String(r.type).replace(/^Gui/, "")}) = ${JSON.stringify(r.value)}`);
  }
  if (a.then === undefined) return out.join("\n");
  // the guard still applies: the fields did not change the dynpro, so the same expect holds
  if (typeof a.then === "string") {
    const vkey = VKEYS[a.then];
    return withScreen(`${out.join("\n")}\nsent ${a.then} (vkey ${vkey})`, await call("vkey", { session: a.session, vkey, expect: ex, confirm: a.confirm }), a.view);
  }
  return withScreen(`${out.join("\n")}\npressed ${a.then.press}`, await call("press", { session: a.session, id: a.then.press, expect: ex, confirm: a.confirm }), a.view);
}));

server.registerTool("sap_press", {
  title: "Press button / select tab or menu",
  description: "Press a button or toolbar button, select a tab, menu entry or radio button by element id. On a list line (lbl[col,row]) or a field it sets the cursor there and double-clicks (F2), e.g. to pick a line in a classic list. Returns the resulting screen.",
  inputSchema: { id: z.string().describe("Element id, e.g. wnd[0]/tbar[1]/btn[8]"), session, view, expect, confirm },
}, async (a) => run(async () => withScreen(`pressed ${a.id}`, await call("press", { ...a, expect: parseExpect(a.expect) }), a.view)));

server.registerTool("sap_send_key", {
  title: "Send virtual key",
  description: "Send a key to the active window (or 'window'). Named keys: " + Object.keys(VKEYS).join(", ") +
    ". Or pass a numeric SAP VKey. Save/F11 writes data – confirm with the user first. Returns the resulting screen.",
  inputSchema: {
    key: z.union([z.enum(Object.keys(VKEYS) as [string, ...string[]]), z.number().int().min(0).max(99)]),
    window: z.string().optional().describe("e.g. wnd[1] for a pop-up; default active window"),
    session, view, expect, confirm,
  },
}, async (a) => run(async () => {
  const vkey = typeof a.key === "number" ? a.key : VKEYS[a.key];
  return withScreen(`sent ${a.key} (vkey ${vkey})`, await call("vkey", { session: a.session, vkey, window: a.window, expect: parseExpect(a.expect), confirm: a.confirm }), a.view);
}));

server.registerTool("sap_send_command", {
  title: "Send OK-code",
  description: "Send a command to the OK-code field, e.g. '/nSE16N', '/o', '=BACK'. Returns the resulting screen.",
  inputSchema: { command: z.string().min(1), session, view, expect, confirm },
}, async (a) => run(async () => {
  if (/^\/[nNoO]\w/.test(a.command)) await checkTcode(a.command);
  return withScreen(`sent ${a.command}`, await call("command", { ...a, expect: parseExpect(a.expect) }), a.view);
}));

server.registerTool("sap_read_grid", {
  title: "Read ALV grid",
  description: "Read rows of an ALV grid (element with control=SapGridWrapper). Returns tab-separated rows with technical column names and titles. Page with firstRow.",
  inputSchema: {
    id: z.string().describe("Grid id, e.g. wnd[0]/shellcont/shell"),
    firstRow: z.number().int().min(0).optional(),
    maxRows: z.number().int().min(1).max(500).optional().describe("Default 50"),
    columns: z.array(z.string()).optional().describe("Technical column names; default all in display order"),
    session,
  },
  annotations: { readOnlyHint: true },
}, async (a) => run(async () => formatGrid(await call<Grid>("grid", a))));

server.registerTool("sap_read_table", {
  title: "Read table control",
  description: "Read rows of a classic dynpro table control (type=TableControl in sap_screen, e.g. item lists in ZPOST/ZDISPLAY, SM30, selection criteria in SE16H). " +
    "Returns column names/titles and cell values per row. Cells are addressed by VISIBLE row: <table id>/<field>[col,visibleRow] – use those ids with sap_set_fields. " +
    "Default: the currently visible page. Rows outside it are read by scrolling the table (a server round trip); the returned cell ids refer to the final scroll position. " +
    "Empty rows are skipped unless skipEmpty=false.",
  inputSchema: {
    id: z.string().describe("Table control id from sap_screen, e.g. wnd[0]/usr/tblSAPLXYZCTRL_0500"),
    firstRow: z.number().int().min(0).optional().describe("Absolute first row; default = current scroll position"),
    maxRows: z.number().int().min(1).max(500).optional().describe("Default 50"),
    columns: z.array(z.string()).optional().describe("Field names or column titles; default all"),
    skipEmpty: z.boolean().optional().describe("Skip rows whose cells are all empty (default true)"),
    session,
  },
  annotations: { readOnlyHint: true },
}, async (a) => run(async () => formatTable(await call<Table>("table", { ...a, titleMode: "p2m" }))));

server.registerTool("sap_reload_bridge", {
  title: "Reload bridge",
  description: "Reload scripts/bridge.js inside SAP GUI (after changing the bridge code) without the Scripting menu. " +
    "Waits until the new bridge answers. The SAP GUI screen and session are not touched.",
  inputSchema: {},
}, async () => run(async () => {
  const before = await readInfo();
  const r = await call("reload");
  for (let i = 0; i < 50; i++) {
    await new Promise(res => setTimeout(res, 200));
    try {
      const now = await readInfo();
      if (now.started !== before.started) {
        const s = await call("status");
        return `bridge reloaded from ${r.script}: ${before.version} → ${s.bridge}, port ${now.port}`;
      }
    } catch { /* bridge.json is being rewritten */ }
  }
  throw new BridgeError("bridge did not come back within 10 s – check ~/.sapgui-java-mcp/bridge.log (reload-error) or restart it from the Scripting menu");
}));

server.registerTool("sap_read_tree", {
  title: "Read tree",
  description: "Read nodes of a tree control (control=SapTreeWrapper): key, parent key, text, folder/expanded flags.",
  inputSchema: {
    id: z.string().describe("Tree id from sap_screen"),
    maxNodes: z.number().int().min(1).max(2000).optional().describe("Default 300"),
    session,
  },
  annotations: { readOnlyHint: true },
}, async (a) => run(async () => {
  const t = await call("tree", a);
  const lines = [`tree ${t.id}: ${t.returned} of ${t.total} nodes, selected=${JSON.stringify(t.selected)}`, "key\tparent\tfolder\ttext"];
  for (const n of t.nodes) lines.push(`${n.key}\t${n.parent}\t${n.folder ? (n.expanded ? "open" : "closed") : ""}\t${n.text}`);
  return lines.join("\n");
}));

await server.connect(new StdioServerTransport());
