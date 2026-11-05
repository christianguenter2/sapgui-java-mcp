#!/usr/bin/env node
// sapgui-java-mcp – MCP server for SAP GUI for Java (via scripts/bridge.js)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { call, callBridge, readConfig, listBridges, statusAll, BridgeError } from "./bridge.js";
import { formatGrid, formatTable, formatList, formatCtxMenu, formatText, Screen, Grid, Table, ListResult, CtxMenuResult, TextResult } from "./format.js";
import { renderScreen, View, VIEWS } from "./view.js";
import { parseExpect } from "./expect.js";
import { userFormats, cachedFormats } from "./formats.js";
import { agentSessions, openAgentSession, closeAgentSession } from "./session.js";

const server = new McpServer(
  { name: "sapgui-java", version: "0.14.0" },
  {
    instructions:
      "Drives a logged-on SAP GUI for Java session through its scripting API. " +
      "You work in your OWN session (opened automatically next to the user's; see sap_status, sap_open_session) – " +
      "the user keeps theirs. Only use the user's session when they explicitly ask. " +
      "Workflow: sap_screen to see the current window (element ids like wnd[0]/usr/ctxtFIELD), " +
      "then sap_set_fields / sap_press / sap_send_key. Every action returns the resulting screen and status bar " +
      "(by default only what changed on the same screen, or a compact view of a new screen), so do not call " +
      "sap_screen again after an action; use view=full only when an element seems to be missing. Always read the status bar: [E] = error, [W] = warning, " +
      "[S] = success. Pop-ups appear as wnd[1], wnd[2]; their question and answer buttons are shown in a POPUP block – read it before answering, never guess. ALV grids and trees show up as control=SapGridWrapper / " +
      "SapTreeWrapper – read them with sap_read_grid / sap_read_tree and act on them with sap_grid_action / sap_tree_action; classic table controls (type TableControl) " +
      "with sap_read_table; text and ABAP editors (control=SapTextEditWrapper / SapAbapEditorWrapper, shown as lines=N) with sap_read_text / sap_set_text. Ask the user before saving data (Ctrl+S / " +
      "save buttons) or changing anything outside development/customizing tasks; the write gate enforces this: " +
      "Save/Post only run with confirm=true plus expect. Type amounts and dates in the user's formats (sap_user_formats, once per session). Pass expect (e.g. \"SAPLSE16N/120\", " +
      "copied from the last screen header) on every Save/Post and whenever the user may use the same session – " +
      "the action is then refused if the screen changed. Errors name the screen the session is on.",
  },
);

const system = z.string().optional().describe(
  "System as SID/client, e.g. A4H/001 – picks the agent session of that system (the right SAP GUI when several run). " +
  "Default: the only system logged on, else config defaultSystem, else the system used last.");
const session = z.string().optional().describe(
  "Session path, e.g. con[0]/ses[1]. Default: the agent's own session (opened automatically). " +
  "Pass the user's session (e.g. con[0]/ses[0]) only when the user explicitly asks you to work in it.");

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
  z.string().describe('Short form as in the screen header: "SAPLSE16N/120", optionally with transaction and window: "SE16H SAPLSE16N/120 wnd[0]"'),
  z.object({
    program: z.string().optional(), screen: z.number().int().optional(),
    window: z.string().optional().describe("e.g. wnd[1]"), transaction: z.string().optional(),
  }),
]).optional().describe("Screen guard – refuse the action unless the session is on this screen. Use it for every write (Save/Post) and when the user may be working in the same session.");

const confirm = z.boolean().optional().describe(
  "Write gate: Save/Post (vkey 11, btn[11], Save/Post/Buchen buttons, OK-codes =BU/=SAVE …) are refused unless " +
  "confirm=true AND expect is given. Set it only after the user approved this specific save/post.");

function withScreen(head: string, r: { screen?: Screen }, v: View | undefined): string {
  return r.screen ? `${head}\n${renderScreen(r.screen, v ?? "changed")}` : head;
}

const menuItem = z.string().optional().describe("Function code: of a toolbar menu entry, or of a context menu entry (code from the listed entries)");
const menuText = z.string().optional().describe("Context menu entry by its text, or \"Submenu > Entry\" – instead of menuItem");

// grid/tree action result: the context menu entries (while it is open) or the selected entry, then the screen
function withCtxMenu(head: string, r: CtxMenuResult & { screen?: Screen }, v: View | undefined): string {
  return withScreen(head + formatCtxMenu(r), r, v);
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
// SAP vkeys 13–24 = Shift+F1–F12, 25–36 = Ctrl+F1–F12, 37–48 = Ctrl+Shift+F1–F12
for (let i = 1; i <= 12; i++) {
  VKEYS[`Shift+F${i}`] = 12 + i; VKEYS[`Ctrl+F${i}`] = 24 + i; VKEYS[`Ctrl+Shift+F${i}`] = 36 + i;
}

// ----------------------------------------------------------------- tools
server.registerTool("sap_status", {
  title: "SAP GUI status",
  description: "All SAP GUI processes with a bridge, their connections and sessions (system, client, user, transaction, screen). " +
    "Session references in the output (e.g. 196634/con[0]/ses[3] when several SAP GUI processes run) are what `session` takes.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => run(async () => {
  const all = await statusAll();
  if (!all.length) throw new BridgeError("no SAP GUI bridge is running – start SAP GUI with the bridge");
  const agentRefs = new Set(agentSessions().values());
  const lines: string[] = [];
  for (const r of all) {
    if (!r.status) { lines.push(`SAP GUI pid ${r.bridge.pid}: bridge ${r.bridge.version ?? "?"} not answering – ${r.error}`); continue; }
    const s = r.status;
    lines.push(`SAP GUI pid ${r.bridge.pid}: bridge ${s.bridge}, SAP GUI ${s.gui}`);
    for (const c of s.connections) {
      lines.push(`  ${c.id.replace(/^\/app\//, "")} ${JSON.stringify(c.description)} ${c.connectionString}${c.disabledByServer ? " – SCRIPTING DISABLED BY SERVER (reconnect after enabling)" : ""}`);
      for (const x of c.sessions) lines.push(x.error ? `    session error: ${x.error}` :
        `    ${x.ref}: ${x.system}/${x.client} ${x.user} ${x.language} | ${x.transaction} ${x.program}/${x.screen}${x.readOnly ? " (read-only)" : ""}` +
        (x.agent ? (agentRefs.has(x.ref) ? `  ← agent session for ${x.system}/${x.client}` : "  (agent)") : "  (user)") +
        ((f) => f ? `\n      input formats: date ${f.date}, numbers ${f.decimal}, time ${f.time}` : "")(cachedFormats(`${x.system}/${x.client}/${x.user}`)));
    }
  }
  return lines.join("\n");
}));

server.registerTool("sap_user_formats", {
  title: "User input formats",
  description: "Date format, decimal notation and time format of the logged-on user (user defaults, SU3). " +
    "Opens SU3 in a separate session, system, reads the Defaults tab and closes that session again – the current session is not touched. " +
    "Cached per system/client/user; call it once before typing amounts or dates.",
  inputSchema: { session, system, refresh: z.boolean().optional().describe("Read again instead of using the cache") },
  annotations: { readOnlyHint: true },
}, async (a) => run(async () => {
  const f = await userFormats(a.session, a.refresh, a.system);
  return `${f.user}: date ${f.date}, numbers ${f.decimal}, time ${f.time}` +
    `${f.timeZone ? `, time zone ${f.timeZone}` : ""}${f.systemTimeZone ? ` (system ${f.systemTimeZone})` : ""}` +
    `\nraw USR01 keys: DATFM=${JSON.stringify(f.raw.datfm)} DCPFM=${JSON.stringify(f.raw.dcpfm)} TIMEFM=${JSON.stringify(f.raw.timefm)}` +
    `\ne.g. amount 2000.50 → ${f.decimal.startsWith("1.") ? "2000,50" : f.decimal.startsWith("1,") ? "2000.50" : "2000,50"}, ` +
    `date 30 June 2026 → ${f.date.replace("DD", "30").replace("MM", "06").replace("YYYY", "2026")}`;
}));

server.registerTool("sap_screenshot", {
  title: "Screenshot",
  description: "PNG of the active window of a session (or the given window, e.g. wnd[1]) via SAP GUI's HardCopy. " +
    "Returns the image itself plus the saved path (~/.sapgui-java-mcp/screenshots/, last 20 kept). " +
    "Use it when the screen model is not enough: layout, column headings, colours, icons, or to show the user what you see.",
  inputSchema: { window: z.string().optional().describe("e.g. wnd[1]; default the active window"), session, system },
  annotations: { readOnlyHint: true },
}, async (a) => {
  try {
    const r = await call("screenshot", a);
    const data = (await readFile(r.path)).toString("base64");
    const ses = r.session;
    return {
      content: [
        { type: "image" as const, data, mimeType: "image/png" },
        { type: "text" as const, text: `${ses.system}/${ses.client} ${ses.ref ?? ses.id} ${ses.transaction} ${ses.program}/${ses.screen} ${r.window} ${JSON.stringify(r.title)} – ${r.width}×${r.height}, ${Math.round(r.bytes / 1024)} KB, saved ${r.path}` },
      ],
    };
  } catch (e: any) {
    return { content: [{ type: "text" as const, text: e instanceof BridgeError ? e.message : `unexpected error: ${e?.message ?? e}` }], isError: true };
  }
});

server.registerTool("sap_open_session", {
  title: "Open own session",
  description: "Open a new SAP GUI session for the agent (next to the user's) and make it the default for all tools. " +
    "Normally not needed – the first tool call opens one automatically. Use it to start fresh.",
  inputSchema: {
    system,
    base: z.string().optional().describe("Session whose connection to use (reference from sap_status); default a user session of the system"),
    view,
  },
}, async (a) => run(async () => {
  const r = await openAgentSession(a.system, a.base);
  const scr = await call("screen", { session: r.session });
  return `opened agent session ${r.session} for ${r.system} (now its default)\n${renderScreen(scr, a.view ?? "status")}`;
}));

server.registerTool("sap_close_session", {
  title: "Close own session",
  description: "Close the agent's own session (or another session the agent opened). User sessions are refused.",
  inputSchema: { session: z.string().optional().describe("Default: the agent session of the system"), system },
}, async (a) => run(async () => `closed ${await closeAgentSession(a.session, a.system)}`));

server.registerTool("sap_screen", {
  title: "Read current screen",
  description: "Current window of a session: title, status bar, and all fields/buttons/tabs/controls with ids, values and flags. Menus are omitted unless includeMenus.",
  inputSchema: {
    session, system,
    includeMenus: z.boolean().optional().describe("Include the menu bar tree (large)."),
    maxNodes: z.number().int().min(20).max(3000).optional().describe("Element limit, default 400."),
    view: z.enum(VIEWS).optional().describe("compact (default: toolbars in one line, labels merged, empty read-only fields omitted), changed, status or full"),
  },
  annotations: { readOnlyHint: true },
}, async (a) => run(async () => renderScreen(await call<Screen>("screen", a), a.view ?? "compact")));

server.registerTool("sap_start_transaction", {
  title: "Start transaction",
  description: "Start a transaction in the session (like /n<tcode>). Returns the new screen.",
  inputSchema: { tcode: z.string().min(1).describe("Transaction code, e.g. SE16N"), session, system, view },
}, async (a) => run(async () => {
  await checkTcode(a.tcode);
  return withScreen(`started ${a.tcode.toUpperCase()}`, await call("tcode", a), a.view);
}));

server.registerTool("sap_set_fields", {
  title: "Set field values",
  description: "Set one or more fields in order. Text fields take a string; checkboxes true/false; radio buttons are selected (value ignored); combo boxes take the key (or the visible value with by='value'). " +
    "Also input fields and combo boxes inside controls (control=SapInputFieldWrapper / SapComboBoxWrapper, e.g. SE80 object type and name); " +
    "submit: true on an input field control submits it like Enter (e.g. SE80: shows the object) and returns the resulting screen. " +
    "Optional 'then': a key (e.g. \"Enter\", \"Execute\") or {press: id} sent after the fields – returns the resulting screen like sap_send_key/sap_press, saving a round trip. " +
    "Without 'then' nothing is sent and only the set values are returned.",
  inputSchema: {
    fields: z.array(z.object({
      id: z.string().describe("Element id from sap_screen, e.g. wnd[0]/usr/ctxtGD-TAB"),
      value: z.union([z.string(), z.boolean()]).optional(),
      by: z.enum(["key", "value"]).optional().describe("Combo boxes only."),
      submit: z.boolean().optional().describe("Input field controls (SapInputFieldWrapper) only: submit after setting, like Enter in the field."),
    })).min(1),
    then: z.union([
      z.enum(Object.keys(VKEYS) as [string, ...string[]]),
      z.object({ press: z.string().describe("Button/tab id to press after setting the fields") }),
    ]).optional().describe("Key or {press: id} to send after the fields (e.g. \"Enter\"). Save/F11 writes data – confirm with the user first."),
    session, system, expect, view, confirm,
  },
}, async (a) => run(async () => {
  const out: string[] = [];
  const ex = parseExpect(a.expect);
  let submitted = false;
  for (const f of a.fields) {
    const r = await call("set", { session: a.session, system: a.system, id: f.id, value: f.value ?? "", by: f.by, submit: f.submit, expect: ex });
    out.push(`${r.id} (${String(r.type).replace(/^Gui/, "")}) = ${JSON.stringify(r.value)}${r.submitted ? " – submitted" : ""}`);
    if (r.submitted) submitted = true;
  }
  if (a.then === undefined) {
    if (!submitted) return out.join("\n");
    // a submitted input field made a round trip – show what it led to
    const s = await call<Screen>("screen", { session: a.session, system: a.system });
    return `${out.join("\n")}\n${renderScreen(s, a.view ?? "changed")}`;
  }
  // the guard still applies: the fields did not change the dynpro, so the same expect holds
  if (typeof a.then === "string") {
    const vkey = VKEYS[a.then];
    return withScreen(`${out.join("\n")}\nsent ${a.then} (vkey ${vkey})`, await call("vkey", { session: a.session, system: a.system, vkey, expect: ex, confirm: a.confirm }), a.view);
  }
  return withScreen(`${out.join("\n")}\npressed ${a.then.press}`, await call("press", { session: a.session, system: a.system, id: a.then.press, expect: ex, confirm: a.confirm }), a.view);
}));

server.registerTool("sap_press", {
  title: "Press button / select tab or menu",
  description: "Press a button or toolbar button, select a tab, menu entry or radio button by element id. On a list line (lbl[col,row]) or a field it sets the cursor there and double-clicks (F2), e.g. to pick a line in a classic list. " +
    "Toolbar controls (control=SapToolBarWrapper, buttons listed in the screen): id = the toolbar, button = button id; for a menu button also " +
    "menuItem (without it the menu's entries are returned). Buttons and menu entries that save/delete/post are gated (confirm + expect). Returns the resulting screen.",
  inputSchema: {
    id: z.string().describe("Element id, e.g. wnd[0]/tbar[1]/btn[8], or a toolbar control"),
    button: z.string().optional().describe("Toolbar controls only: button id from the screen's toolbar list"),
    menuItem: z.string().optional().describe("Toolbar controls only: entry of a menu button"),
    session, system, view, expect, confirm,
  },
}, async (a) => run(async () => {
  const r = await call("press", { ...a, expect: parseExpect(a.expect) });
  const head = a.button ? `pressed ${a.button}${a.menuItem ? " > " + a.menuItem : ""} in ${a.id}` : `pressed ${a.id}`;
  return withScreen(head + formatCtxMenu(r), r, a.view);
}));

server.registerTool("sap_send_key", {
  title: "Send virtual key",
  description: "Send a key to the active window (or 'window'). Named keys: " + Object.keys(VKEYS).join(", ") +
    ". Or pass a numeric SAP VKey. Save/F11 writes data – confirm with the user first; so do keys this screen binds to " +
    "save/post/delete/release … (the write gate checks the button or menu entry behind the key). Returns the resulting screen.",
  inputSchema: {
    key: z.union([z.enum(Object.keys(VKEYS) as [string, ...string[]]), z.number().int().min(0).max(99)]),
    window: z.string().optional().describe("e.g. wnd[1] for a pop-up; default active window"),
    session, system, view, expect, confirm,
  },
}, async (a) => run(async () => {
  const vkey = typeof a.key === "number" ? a.key : VKEYS[a.key];
  return withScreen(`sent ${a.key} (vkey ${vkey})`, await call("vkey", { session: a.session, system: a.system, vkey, window: a.window, expect: parseExpect(a.expect), confirm: a.confirm }), a.view);
}));

server.registerTool("sap_send_command", {
  title: "Send OK-code",
  description: "Send a command to the OK-code field, e.g. '/nSE16N', '/o', '=BACK'. Returns the resulting screen.",
  inputSchema: { command: z.string().min(1), session, system, view, expect, confirm },
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
    session, system,
  },
  annotations: { readOnlyHint: true },
}, async (a) => run(async () => formatGrid(await call<Grid>("grid", a))));

server.registerTool("sap_read_table", {
  title: "Read table control",
  description: "Read rows of a classic dynpro table control (type=TableControl in sap_screen, e.g. item lists in entry/display transactions, SM30, selection criteria in SE16H). " +
    "Returns column names/titles and cell values per row. Cells are addressed by VISIBLE row: <table id>/<field>[col,visibleRow] – use those ids with sap_set_fields. " +
    "Default: the currently visible page. Rows outside it are read by scrolling the table (a server round trip); the returned cell ids refer to the final scroll position. " +
    "Empty rows are skipped unless skipEmpty=false.",
  inputSchema: {
    id: z.string().describe("Table control id from sap_screen, e.g. wnd[0]/usr/subTAB_SUB:SAPLSE16N:0121/tblSAPLSE16NSELFIELDS_TC"),
    firstRow: z.number().int().min(0).optional().describe("Absolute first row; default = current scroll position"),
    maxRows: z.number().int().min(1).max(500).optional().describe("Default 50"),
    columns: z.array(z.string()).optional().describe("Field names or column titles; default all"),
    skipEmpty: z.boolean().optional().describe("Skip rows whose cells are all empty (default true)"),
    session, system,
  },
  annotations: { readOnlyHint: true },
}, async (a) => run(async () => formatTable(await call<Table>("table", { ...a, titleMode: "p2m" }))));

server.registerTool("sap_reload_bridge", {
  title: "Reload bridges",
  description: "Reload scripts/bridge.js in every SAP GUI process with a bridge (after changing the bridge code) without the " +
    "Scripting menu. Waits until each new bridge answers. Screens and sessions are not touched.",
  inputSchema: {},
}, async () => run(async () => {
  const before = await listBridges();
  if (!before.length) throw new BridgeError("no SAP GUI bridge is running");
  const out: string[] = [];
  for (const b of before) {
    let script = "?";
    try { script = (await callBridge(b, "reload")).script; }
    catch (e: any) { out.push(`pid ${b.pid}: reload refused – ${e?.message ?? e}`); continue; }
    let done = false;
    for (let i = 0; i < 50 && !done; i++) {
      await new Promise(res => setTimeout(res, 200));
      const now = (await listBridges()).find(x => x.pid === b.pid);
      if (now && now.started !== b.started) {
        try { const s = await callBridge(now, "status"); out.push(`pid ${b.pid}: ${b.version} → ${s.bridge}, port ${now.port} (${script})`); done = true; }
        catch { /* not up yet */ }
      }
    }
    if (!done) out.push(`pid ${b.pid}: did not come back within 10 s – check ~/.sapgui-java-mcp/bridge.log (reload-error)`);
  }
  return `bridges reloaded:\n` + out.join("\n");
}));

server.registerTool("sap_grid_action", {
  title: "ALV grid action",
  description: "Act on an ALV grid (control=SapGridWrapper): setCurrentCell, click, doubleClick, pressButton (button cell) with row + column " +
    "(technical name); selectRows (rows \"0,2-4\"), selectAll, clearSelection; pressColumnHeader (column); pressToolbar (button = toolbar id " +
    "from sap_read_grid); pressToolbarContext (menu button, optional menuItem); selectToolbarMenuItem (menuItem). " +
    "Context menu: contextMenu (on row + column, or the current cell) lists its entries; selectContextMenuItem (menuItem = code " +
    "from that list, or menuText) picks one; contextMenu with menuItem/menuText opens and picks in one call; closeContextMenu. " +
    "Returns the resulting screen. Toolbar buttons and context menu entries that save/delete/post are gated (confirm + expect).",
  inputSchema: {
    id: z.string().describe("Grid id, e.g. wnd[0]/shellcont/shell"),
    action: z.enum(["setCurrentCell", "click", "doubleClick", "pressButton", "selectRows", "selectAll", "clearSelection",
      "pressColumnHeader", "pressToolbar", "pressToolbarContext", "selectToolbarMenuItem",
      "contextMenu", "selectContextMenuItem", "closeContextMenu"]),
    row: z.number().int().min(0).optional(), column: z.string().optional(),
    rows: z.string().optional().describe("selectRows: \"0\", \"0,2\", \"3-7\""),
    button: z.string().optional(), menuItem, menuText,
    session, system, view, expect, confirm,
  },
}, async (a) => run(async () => withCtxMenu(`grid ${a.action}`, await call("grid_action", { ...a, expect: parseExpect(a.expect) }), a.view)));

server.registerTool("sap_tree_action", {
  title: "Tree action",
  description: "Act on a tree (control=SapTreeWrapper) by node key from sap_read_tree: select, expand, collapse, doubleClick; " +
    "selectItem, doubleClickItem, clickLink, pressButton, checkbox (need item = column name or item index); unselectAll. " +
    "Context menu: nodeContextMenu (node), itemContextMenu (node + item), headerContextMenu (item = column), defaultContextMenu " +
    "list the entries; selectContextMenuItem (menuItem = code from that list, or menuText) picks one; an opener with " +
    "menuItem/menuText opens and picks in one call; closeContextMenu. Entries that save/delete/post are gated (confirm + expect). " +
    "Returns the resulting screen.",
  inputSchema: {
    id: z.string().describe("Tree id from sap_screen"),
    action: z.enum(["select", "expand", "collapse", "doubleClick", "selectItem", "doubleClickItem", "clickLink", "pressButton", "checkbox", "unselectAll",
      "nodeContextMenu", "itemContextMenu", "headerContextMenu", "defaultContextMenu", "selectContextMenuItem", "closeContextMenu"]),
    node: z.string().optional().describe("Node key from sap_read_tree"),
    item: z.string().optional(), checked: z.boolean().optional(), menuItem, menuText,
    session, system, view, expect, confirm,
  },
}, async (a) => run(async () => withCtxMenu(`tree ${a.action} ${a.node ?? ""}`.trim(), await call("tree_action", { ...a, expect: parseExpect(a.expect) }), a.view)));

server.registerTool("sap_read_text", {
  title: "Read text editor",
  description: "Read the lines of a multi-line text editor (control=SapTextEditWrapper – long texts, notes) or ABAP editor " +
    "(control=SapAbapEditorWrapper – SE38/SE24/SE37 source) as numbered lines (1-based, the editor's numbering), plus read-only/modified state. " +
    "The screen shows these controls only as lines=N.",
  inputSchema: {
    id: z.string().describe("Editor id from sap_screen, e.g. wnd[0]/usr/cntlEDITOR/shellcont/shell"),
    firstLine: z.number().int().min(1).optional().describe("Default 1"),
    maxLines: z.number().int().min(1).max(5000).optional().describe("Default 500"),
    session, system,
  },
  annotations: { readOnlyHint: true },
}, async (a) => run(async () => formatText(await call<TextResult>("text", a))));

server.registerTool("sap_set_text", {
  title: "Change text editor",
  description: "Change the text of a text editor or ABAP editor (see sap_read_text): without line arguments the whole text is replaced; " +
    "fromLine (+ toLine, default fromLine) replaces those lines; insertBefore inserts before that line (lineCount + 1 appends). " +
    "Lines are 1-based as in sap_read_text; text may contain several lines (\\n). Only changes the editor – saving/activating is a separate, " +
    "gated step. Refused when the editor is read-only (display mode): switch to change mode first. Returns the resulting screen.",
  inputSchema: {
    id: z.string().describe("Editor id from sap_screen"),
    text: z.string().describe("New text; lines separated by \\n"),
    fromLine: z.number().int().min(1).optional(), toLine: z.number().int().min(1).optional(),
    insertBefore: z.number().int().min(1).optional(),
    session, system, view, expect,
  },
}, async (a) => run(async () => {
  if (a.insertBefore !== undefined && (a.fromLine !== undefined || a.toLine !== undefined))
    throw new BridgeError("pass either insertBefore or fromLine/toLine, not both");
  if (a.toLine !== undefined && a.fromLine === undefined) throw new BridgeError("toLine needs fromLine");
  const r = await call<{ lineCount: number; replaced: { fromLine: number; toLine: number; removed: number; inserted: number }; screen?: Screen }>(
    "text_set", { ...a, expect: parseExpect(a.expect) });
  const x = r.replaced;
  const n = (k: number) => `${k} line${k === 1 ? "" : "s"}`;
  const what = a.insertBefore !== undefined ? `inserted ${n(x.inserted)} before line ${x.fromLine}`
    : a.fromLine !== undefined ? `replaced ${x.fromLine === x.toLine ? `line ${x.fromLine}` : `lines ${x.fromLine}..${x.toLine}`} with ${n(x.inserted)}`
    : `replaced the whole text (${n(x.removed)}) with ${n(x.inserted)}`;
  return withScreen(`${what}; editor now has ${r.lineCount} lines – not saved`, r, a.view);
}));

server.registerTool("sap_read_list", {
  title: "Read classic list",
  description: "Read classic list output (WRITE lists, SE16 results, report output, SE03 tools – elements lbl[col,row], txt[…], chk[…] " +
    "in wnd[n]/usr) as a table: one line per list line, one column per cell start position. Far more compact than view=full. " +
    "Lines with a single cell (titles, totals) are printed as text. sap_press on a cell id double-clicks it.",
  inputSchema: {
    window: z.string().optional().describe("e.g. wnd[1]; default the active window"),
    firstLine: z.number().int().min(0).optional().describe("First list line (row index) to show, default 0"),
    maxLines: z.number().int().min(1).max(1000).optional().describe("Default 200"),
    session, system,
  },
  annotations: { readOnlyHint: true },
}, async (a) => run(async () => formatList(await call<ListResult>("list", a), a.firstLine ?? 0, a.maxLines ?? 200)));

server.registerTool("sap_read_tree", {
  title: "Read tree",
  description: "Read nodes of a tree control (control=SapTreeWrapper): key, parent key, text, folder/expanded flags. " +
    "Simple, list and column trees; for column trees the item text of every column is returned as well.",
  inputSchema: {
    id: z.string().describe("Tree id from sap_screen"),
    maxNodes: z.number().int().min(1).max(2000).optional().describe("Default 300"),
    session, system,
  },
  annotations: { readOnlyHint: true },
}, async (a) => run(async () => {
  const t = await call("tree", a);
  const kind = ["simple", "list", "column"][t.treeType] ?? `type ${t.treeType}`;
  const lines = [`tree ${t.id} (${kind} tree): ${t.returned} of ${t.total} nodes, selected=${JSON.stringify(t.selected)}`];
  // column trees: one column per tree column (the first one is the hierarchy text = "text")
  const cols: { name: string; title: string }[] = t.columns ?? [];
  const extra = cols.slice(1);
  if (cols.length) lines.push("columns: " + cols.map(c => `${c.name}=${JSON.stringify(c.title)}`).join(", "));
  lines.push(["key", "parent", "folder", "text", ...extra.map(c => c.name)].join("\t"));
  const clean = (x: unknown) => String(x ?? "").replace(/[\t\n]/g, " ");
  for (const n of t.nodes) {
    const row = [n.key, n.parent, n.folder ? (n.expanded ? "open" : "closed") : "", clean(n.text)];
    if (extra.length) row.push(...extra.map(c => clean(n.items?.[c.name])));
    else if (t.treeType === 1 && n.items) row.push(...Object.values(n.items).slice(1).map(clean));
    lines.push(row.join("\t"));
  }
  return lines.join("\n");
}));

await server.connect(new StdioServerTransport());
