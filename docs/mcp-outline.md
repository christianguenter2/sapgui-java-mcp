# sapgui-java-mcp – outline

MCP server that lets Claude drive **SAP GUI for Java 8.10 on Linux** through the
GUI's built-in scripting API. Status: built and in use against DEV/100 (2026-11-04); this file keeps the design and the findings.

## 1. Facts established so far

| Fact | Source |
|---|---|
| DEV `sapgui/user_scripting = TRUE` (since 2026-11-04); `_per_user`, `_set_readonly`, `_disable_recording`, `_force_notification` = FALSE | RFC `SPFL_PARAMETER_GET_VALUE` |
| Installed client: SAP GUI for Java 8.10 rev 14, SapMachine 21 | `~/SAPClients/SAPGUI8.10rev14` |
| Script engine: GraalJS if `org.graalvm.polyglot.Context` is on the classpath, else Nashorn (`JavaScript`). Install ships **Nashorn 15.7 only** → ES5.1 | `GuiJavaScriptInterpreter.getJSEngineName`, `jar/nashorn*S.jar` |
| Preset script globals: `application`, `connection`, `session` | `GuiJavaScriptInterpreter.createNewScope` |
| Script event hooks: `onStartRequest`, `onEndRequest`, `onSessionCreate`, `onSessionDelete`, `onHit`, `onError` | `GuiJavaScriptInterpreter.hasEventHandlers` |
| Script folders: setting `scriptsDir` (default `<sapgui home>/scripts`), output `fileOutputDir` | `GuiScriptDirectories` |
| API surface = Windows Scripting API object model: `findById`, `startTransaction`, `sendCommand`, `sendVKey`, `HardCopy` (screenshot), status bar `messageType/Id/Number`, `info.*` | `com/sap/platin/{base,r3}/api/scripting/*Wrapper` |
| Controls have their own wrappers in the control jars: `advancedGrid.SapGridWrapper` (ALV: `getRowCount`, `getCellValue`, `getColumnTitles`, `setCurrentCell`, `pressToolbarButton`, `doubleClick`…), `tree.SapTreeWrapper` (`expandNode`, `getNodeTextByKey`, `selectNode`, `getItemText`…), plus TextEdit, ABAP editor, HTML, toolbar, calendar | control jars; tree seen live on Easy Access |
| **Smoke test v2 on DEV (2026-11-04): all checks pass** – session DEV/100, `findById`, status bar, full tree walk; preset objects are normal Java objects (886 direct calls, 0 reflection); scripts run on a worker thread (`Thread-N`, not EDT); GUI calls work from a **background thread** and via `invokeAndWait`; loopback `ServerSocket` OK | `~/sapgui-java-smoke-test.txt` |
| Scripting state is fixed at logon: a connection opened before RZ11 change stays `isDisabledByServer = true` (preset `session` is then the string "Scripting this object is not allowed by the server") | smoke test v2 first run |

## 2. Architecture

```
Claude Code ──MCP stdio──▶ sapgui-java-mcp (Node/TS)
                                │  HTTP/JSON, 127.0.0.1:<port>, Bearer token
                                ▼
                SAP GUI for Java JVM ── bridge.js (Nashorn, started from Scripting menu)
                                │  com.sun.net.httpserver.HttpServer (JDK built-in)
                                ▼
                     application / connection / session wrappers
```

**Why in-process:** the scripting objects only exist inside the GUI JVM; there is
no COM/IPC equivalent on Linux. Nashorn has full Java interop, so the bridge
script can start a JDK `HttpServer` on loopback.

### 2.1 bridge.js (inside the GUI)
- Started once per GUI start from the Scripting menu (later: auto-start, see §6).
- Binds `127.0.0.1:0`, writes `{port, token, pid}` to `~/.sapgui-java-mcp/bridge.json` (mode 600).
- Every request: check `Authorization: Bearer <token>`, then run the operation
  **on the thread the smoke test proves safe** (EDT via `invokeAndWait`, or the
  scripting event queue), with a timeout.
- Round-trip completion: register `onEndRequest` → resolve a latch, so
  `press`/`sendVKey` return only after the server answered (replaces Windows' `session.Busy` polling).
- Endpoints are a fixed operation set (below), **no generic `eval`** in the default build.

### 2.2 sapgui-java-mcp (outside, Node + `@modelcontextprotocol/sdk`)
- Reads `bridge.json`, health-checks, exposes MCP tools, maps errors to clear messages
  ("bridge not running – start bridge.js from Scripting menu").
- Guardrails: transaction allow-list / deny-list, system allow-list (SID+client), audit log
  (JSONL: time, tool, args, result status), optional read-only mode.

## 3. MCP tools (v1)

| Tool | Does | Underlying API |
|---|---|---|
| `sap_status` | bridge up?, GUI version, connections + sessions | `application.getConnections()` … `info.*` |
| `sap_session_info` | system, client, user, tcode, program, screen | `session.getInfo()` |
| `sap_start_transaction` | `/n<tcode>` | `session.startTransaction` |
| `sap_screen` | compact screen model: window title, fields (id, label, value, changeable), buttons, tabs, status bar, modal windows | tree walk of `wnd[n]` |
| `sap_set_field` | set text / checkbox / radio / combo key | `findById(id).setText/setSelected/setKey` |
| `sap_press` | press button / toolbar button / tab / menu | `press()`, `select()` |
| `sap_send_vkey` | Enter, F3, F8, Ctrl+S … | `wnd.sendVKey(n)` |
| `sap_send_command` | OK-code | `session.sendCommand` |
| `sap_read_table` ✅ | rows of a dynpro table control (paged, scrolls for rows off the page) | `GuiTableControl` – see §7 |
| `sap_screenshot` | PNG of current window → path / base64 | `wnd.HardCopy(file, fmt)` |
| `sap_close_popup` | confirm/cancel modal window | `wnd[1]` buttons / `sendVKey 0/12` – superseded: every screen of a modal window carries a POPUP block (texts + answer buttons with ids), answer with `sap_press` |
| `sap_read_grid` / `sap_read_tree` | **v2, only if spike passes** (Personas wrappers) | `Personas GridView/Tree` |

Every action tool returns the resulting `sap_screen` summary + status bar, so Claude
sees the effect of each step without an extra call.

## 4. Security

- Loopback only, random port, 256-bit token, token file 600, bridge stops when GUI exits.
- No generic eval endpoint by default (an eval endpoint = arbitrary code in a logged-in SAP session).
- Allow-list DEV/100 only to start; refuse production SIDs by config.
- Audit log of every write action.
- The GUI's "a script is attaching" notification: keep it on for manual use; the bridge attaches once at start.

## 5. Phases

| Phase | Content | Exit criterion |
|---|---|---|
| 0 Smoke test | `scripts/sgj-smoke-test.js` | report shows session info, tree, thread result, socket OK |
| 1 Bridge spike ✅ | bridge.js with `/status`, `/screen`, `/set`, `/press`, `/vkey`, `/tcode`, `/command`, `/grid`, `/tree`; curl-tested | **passed 2026-11-04**: SE16N → T000 → Enter → F8 → ALV grid 6 rows (matches SQL); wrappers stay valid after the start script ends; round trips 0.3–0.6 s |
| 2 MCP server ✅ | Node TS server (`mcp/`), 11 tools, compact text output, deniedTransactions | built + tested over MCP stdio 2026-11-04; registered in Claude Code (`claude mcp add --scope user sapgui-java …`) and used live (SE16H, ZPOST posting, ZDISPLAY). Open: SM30 run on `/XYZ/CFG_PARAM_V` |
| 3 Controls 🟡 | ALV grid + tree via `SapGridWrapper`/`SapTreeWrapper` ✅, dynpro table controls `/table` ✅ (§7), HTML viewer text ✅ (§8); textedit open | read an ALV result list ✅ |
| 3a Agent ergonomics ✅ | pop-up text (§8), self-reload `/reload` (§8), screen views compact/changed/status/full (−71 % / −94 % on ZPOST), screen guard `expect` + screen context in errors | 2026-11-04 |
| 4 Comfort | auto-start bridge, reconnect, multi-session, screenshot tool | — |

Estimate: phase 1 ≈ 1 day, phase 2 ≈ 1–2 days, phase 3 open (depends on spike).

## 6. Open questions (answered by the smoke test or phase 1)

1. ~~**Threading**~~ – answered: background threads and `invokeAndWait` both work for reads.
   Still to verify for *actions* (press/sendVKey) – serialize all requests through one executor anyway.
2. **Bridge lifetime** – does a thread/HttpServer started from a script survive after the
   script returns, or does `cleanUp()` tear down the scope and invalidate wrappers?
   → bridge must re-acquire `application` per request via `GuiApplication.currentApplication()` if needed.
3. **Auto-start** – any settings key / command-line option to run a script at GUI start?
   Fallback: a Java agent (`-javaagent` in the guistart JVM options) that calls the interpreter.
4. ~~**Grid/tree**~~ – answered: `SapGridWrapper` / `SapTreeWrapper` exist and the tree is reachable
   via `findById` (seen on Easy Access). Grid still to be seen live on an ALV list → move to phase 2.
5. **Wait semantics** – is `onEndRequest` reliable for "screen ready" incl. modal popups?

## 7. Table controls (`/table`, `sap_read_table`) – findings 2026-11-04

Tested on ZDISPLAY (item list 0500, G/L list 0600, overview 0705 ×2) and SE16H selection criteria (T001).

- Cells: `getCell(visibleRow, col)`; ids `<table>/<cell>[col,visibleRow]` – the visible row is
  relative to the scroll position. Setting a cell via that id with `/set` works (SE16H `LOW[2,1]`).
- **Data rows = vertical scrollbar `getMaximum()`** (SE16H T001: 82 = DD03L fields; one-line ZDISPLAY
  lists: 1). `getRowCount()` also counts the empty lines below the data (123 / 16 / 15 / 5).
- Rows outside the visible page: `getVerticalScrollbar().setPosition(n)` (server round trip), then
  re-`findById` the table. 82 rows with one scroll ≈ 0.45 s.
- A column may have no cell in some rows (SE16H row MANDT) → column metadata from the first row
  that has a cell.
- **`GuiTableColumnWrapper.getTitle()` is wrong when a line layout reorders columns** (ZDISPLAY layout
  Z03): it calls `GuiTableControl.getPersonasColumnTitle(mCol)`, which applies `p2mColumn` again.
  Correct title for presentation column c = `GuiTableControl.getColumnName(p2mColumn(c))`, read via
  the wrapper's `mScriptObject` field. Verified against a screenshot; `titleMode` on `/table`
  (`p2m` default, `wrapper`, `direct`, `m2p`, `wrapperM2p`, `personas`) + `debugTitles` keep the
  alternatives available.

## 8. Pop-up text and bridge reload – findings 2026-11-04

**Pop-up text.** SPO1 confirmations (`SAPLSPO1/0500`, e.g. ZPOST "Checking posting key") put
the question into an HTML viewer; the scripting wrapper `SapBrowserWrapper` has no read method.
Path that works: wrapper `mScriptObject` (= CET `GuiShell`) → `mJavaObject` (= `SapBrowser` bean)
→ `mBrowser` (JxBrowser `Browser`) → `mainFrame().text()` (+ child frames). JxBrowser's
implementation classes are not public → call through the `Browser`/`Frame` interfaces by reflection
(GUI class loader). Failures are reported per step as `htmlErr`.
For every modal window the bridge returns `popup {title, texts, buttons}`: HTML text, read-only text
fields (`MESSTXT1` in information pop-ups), labels; buttons of `usr` and `tbar[0]` with ids. Verified:
SPO1 question ("<key> does not exist. Do you want to create the key?") and SAPMSDYP information
pop-up. HTML viewers in `wnd[0]` (Easy Access start page) also get an `html=` excerpt.

**Reload.** `/reload` (MCP `sap_reload_bridge`, `sgb reload`) re-loads the bridge file in a new
thread via Nashorn `load()`; the new instance stops the old server, no start dialog. The path is
never taken from the request: Nashorn `__FILE__` (null when started from the Scripting menu) or
`bridgeScript` in `~/.sapgui-java-mcp/config.json`. The GUI class loader is kept in a JVM system
property so a reloaded bridge (no preset `application`) still reaches SAP GUI. Round trip ≈ 0.65 s.

## 9. ALV grid lazy loading – 2026-11-04

`SapGridWrapper` rows outside the visible page are loaded from the server **asynchronously** after
`setFirstVisibleRow`. Seen once on SE16H T001 (rows 47–69 empty), not reproducible later – a race.
`/grid` now scrolls, then polls until the first row of the new page has content (≤ 1 s), gives
completely empty rows a second pass, and returns the rest as `emptyRows` (MCP: WARNING line).
"Empty" means *all* grid columns (`getColumnOrder()`) are empty, not just the requested ones – a
real ALV row always has its key; checking only the requested columns gave false alarms on sparse
columns (T001-STCEG) and cost 3 s of waiting. Total wait per request is capped at 3 s.

## 10. User formats and write gate – 2026-11-04

**User formats.** `GuiSessionInfo` (behind the scripting wrapper) has `getDateFormat()`,
`getDecimalFormat()`, `getUserTimeZone()` – all empty in the Java GUI (probably Personas only). A first
mapping of the empty DCPFM to "1.234.567,89" was right only by accident; empty must mean unknown.
`sap_user_formats` reads SU3 → tab Defaults (`cmbSUID_ST_NODE_DEFAULTS-DATFM/-DCPFM/-TIMEFM`,
`txtTTZCU-TZONESYS`) in a separate session (`/oSU3`, closed with `/i`), cached per system/client/user.
DEV/100 TESTUSER: DATFM 1 (DD.MM.YYYY), DCPFM blank (combo key trimmed to "" → 1.234.567,89), TIMEFM 0.
Watch out: `lbl…-DATFM` ends like the field – match on the field types, not on the name alone.

**Write gate.** In the bridge (`writeIntent` + `checkWrite`), because only the bridge sees the
button text at press time: vkey 11, `tbar[0]/btn[11]`, buttons/tooltips starting with
Save/Post/Buchen/Sichern/Speichern/Enregistrer/Comptabiliser, OK-codes `=BU =SAVE =SICH =SPEI =POST
=UPDA /11` via `/command` or typed into `okcd` + Enter. Without `confirm` → 428; `confirm` without
`expect` → 428. Config `confirmWrites: false` turns it off. Tested on SE16H (all five variants refused,
Enter unaffected).

**Extension (bridge 0.5.0, 2026-11-05).** ZCLOSE showed that not every write is called Save: "Close"
plus Yes in an SPO1 pop-up closed posting key <recon-key> at once, without the gate noticing.
Now also gated:
- buttons whose text/tooltip starts with Close/Release/Reverse/Delete/Freigeben/Löschen/Stornieren/
  Schliessen/Abschliessen ("Cancel" = F12 is navigation and stays free);
- **Yes in a confirmation pop-up** (`SPOP-OPTION1`, `BUTTON_1`, text Yes/Ja/Oui) and **Enter on it**
  (triggers the default answer), when the pop-up's question matches save/post/close/delete/reverse/
  release/create (+ German). Content-based on purpose: "No" to "Save changes?" (= discard) and
  "Continue" on information pop-ups stay free; information texts ("…created", "…posted") do not match
  because of the word boundaries.
Tested without committing anything: ZPOST "create the key?" Yes/Enter refused, Cancel free; /XYZ/CFG
Delete refused, "Save changes?" Yes refused, No free (DB: no key, no parameter created).
Still not covered: function codes behind menu entries and context menus, F-keys other than F11 that a
program maps to saving, ALV toolbar buttons (`pressToolbarButton`).

## 11. Lists, column trees, SE54 – 2026-11-05

- **Classic lists** (`lbl[col,row]`, e.g. RSWBO052 "Change Object Directory Entries"): a line is picked
  by cursor + double-click. `/press` on a `GuiLabel` / text field now does `setFocus()` + F2 on its window.
- **Tree texts** (fixed 2026-11-05): the SE03 tool tree is a *simple* tree (type 0), not a column
  tree – yet `getNodeTextByKey()` returned "" for every node. `SapTree.getNodeTextByKey` picks the
  entry object by `getID()` as index, which does not match there, although the entry *is* a
  `TreeString` with the text. `/tree` now reads empty texts straight from the model: wrapper →
  `mScriptObject` (`GuiShell`) → `mJavaObject` (`SapTree`) → `getNode(key).getEntry().getObjects()`,
  collecting `getString()`/`getText()` values. List trees (1) and column trees (2) additionally return
  `getItemText(key, column)` per item/column (`items`; MCP prints one column per tree column).
  `debug: true` on `/tree` reports bean/node/entry classes per node.
- **SE54 leftover** `/XYZ/CFG_PARAM`: TVDIR pointed to function group `/XYZ/CFG_PARAM_M`, whose main
  program no longer existed → SE54 offered only Create, menu Change/Delete disabled. Cleaned up via the
  initial screen's "Generated Objects" Delete (`btn*VIMDYNFLDS-PUSH_DELE` – the `*` one; the first
  Delete belongs to "ABAP Dictionary"): maintenance module, TVDIR, OBJH type S removed (TDDAT went
  with it); OBJH type C (view cluster) and the table kept. Recorded in <request> / task <request>.
  The orphaned TADIR `R3TR FUGR /XYZ/CFG_PARAM_M` stays (RSWBO052 cannot delete entries; SAP: TK/233
  "object does not exist"); it is in <request>, so the import deletes it in the target as well.
- The write gate caught the menu entry "Delete" too (it reads the element text for every press).

## 12. Agent session and bridge auto-start – 2026-11-05

**Own session.** User and agent shared `ses[0]`; the user navigating in it broke the agent's flow
three times (ZPOST, SE54 ×2 – the screen guard caught each). Now:
- bridge `/session_open` (`GuiSessionWrapper.createSession()`, waits ≤ 5 s for the new id) and
  `/session_close` (`GuiConnectionWrapper.closeSession(id)`) – closing is refused (403) for sessions
  the bridge did not open; their ids live in a JVM system property (survives `/reload`); `/status`
  marks them `agent: true`.
- MCP `session.ts`: with `ownSession` (default true) every session endpoint without an explicit
  `session` goes to the agent session – opened on first use, re-checked every 10 s, reopened when
  closed, adopted from the bridge after an MCP restart. Screen headers show the session (`ses[2]`).
- Tested: user session untouched while the agent ran SE16H in `ses[2]`; closing `ses[0]` refused;
  agent session closed behind the MCP's back → next call opened a new one.

**Auto-start (built).** No script auto-start setting exists (interpreter knows only `scriptsDir`
and the hooks `onSessionCreate`/`onSessionDelete` of a running script). But `bin/sapgui` → `guilogon`
runs `exec "${PLATIN_JAVA}" ${JRE_ARGS} …` with `PLATIN_JAVA` taken from the environment → a wrapper
can add `-javaagent:`; the agent waits for `GuiApplication.currentApplication()` and evaluates
`bridge.js` in Nashorn (same path as `/reload`).

Built 2026-11-05: `agent/BridgeAgent.java` (premain + agentmain + attach `main`). Pitfalls: SAP GUI
classes come from SAP's own class loader – found via `Instrumentation.getAllLoadedClasses()`; the
interpreter's `init()` does `new ScriptEngineManager()`, which searches the **thread context class
loader** – without setting it to the GUI loader `mScriptEngine` stays null. `guilogon` probes
`$PLATIN_JAVA -jar GuiStartS.jar getopts` and parses stdout → the wrapper passes `getopts` through
without the agent, and the agent never writes to stdout. Verified by attaching to the running GUI
(bridge event `autostart`, screen access in the agent session, `/reload` via the path the agent
passes in `sapgui-java-mcp.script`). Launcher: `scripts/install-autostart.sh`.
