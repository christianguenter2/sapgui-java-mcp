# sapgui-java-mcp

Lets Claude drive **SAP GUI for Java on Linux** through the SAP GUI scripting API, via MCP.

```
Claude Code ⇄ MCP server (Node, stdio, mcp/) ⇄ HTTP 127.0.0.1 + token ⇄ scripts/bridge.js (Nashorn, inside SAP GUI) ⇄ scripting API
```

The agent works in **its own SAP GUI session** next to yours, every Save/Post needs an explicit
confirmation, and screens come back in a compact, token-saving form. Design notes and everything
learned on the way (with dates): [docs/mcp-outline.md](docs/mcp-outline.md). Changes: [CHANGELOG.md](CHANGELOG.md).

> **Status: experimental (0.14.0).** Use it on **development, test and trial systems only** – never on
> production. An AI agent drives a logged-on SAP GUI with your user's authorizations. The write gate
> (`confirm`) is a **heuristic** based on button texts, OK-codes and pop-up questions in English and
> German; it does not catch every write (a menu entry or key whose text is not a save/commit word in
> English or German, for example – the front end never sees function codes), and it is no substitute for
> authorizations and your own review. You use this software at your own risk (see [LICENSE](LICENSE)).

> **Internals.** SAP GUI's public scripting API leaves gaps (pop-up HTML text, some tree texts, table
> column titles, script start without dialog). The bridge closes them by reading **undocumented
> internals** of SAP GUI for Java (private fields and classes found by inspecting the client). They
> can change with any SAP GUI release; tested with SAP GUI for Java 8.10 on Linux. Check SAP's license
> terms for your use. This project is not affiliated with or endorsed by SAP.

## Why not Web GUI in a browser?

An agent could also drive SAP GUI for HTML (Web GUI) with a browser automation tool. The
comparison below is from building this project, not from a head-to-head benchmark.

| | sapgui-java-mcp | Web GUI + browser automation |
|---|---|---|
| What the agent sees | Elements with id, type, value, read-only flag; ALV grids, trees, table controls, lists and editors as rows and lines | Generated HTML (cryptic element ids, lazily rendered grids) or screenshots, to be interpreted |
| Tokens | Compact screen views (about −70 % / −90 % on large entry screens), `sap_read_list` −96 % on an SE16 page | Pages are much larger than the information on them |
| Safety | SAP-aware: write gate (save/post/delete buttons, keys, menus, pop-up questions), screen guard, own agent session, `allowedSystems`, audit log | Whatever the browser tool offers – nothing SAP-specific |
| Timing | A scripting call returns when the server has answered | The agent has to wait for and detect page reloads |
| Prerequisites on the SAP system | Scripting enabled (`sapgui/user_scripting`); normal desktop logon incl. SSO | The Web GUI ICF service must be active (often off on development systems); some transactions and controls are not supported in Web GUI |
| Prerequisites on the client | SAP GUI for Java, this bridge, Node.js | Just a browser – any operating system |
| Stability | Relies partly on undocumented SAP GUI internals (see above) – a SAP GUI update can break parts; `npm run test:live` catches that | Public web technology, but Web GUI's HTML is not a stable interface either |
| Fiori apps | Not covered | Same browser, same tool |
| ABAP debugger | Not possible – the scripting API blocks while the debugger holds the session ([docs/mcp-outline.md §23](docs/mcp-outline.md)) | Not supported – `/h` and SE38 "Debugging" are refused with message SY620 ("Action not possible in SAP GUI for HTML. Use external debugging.") |

In short: for classic transactions – development, customizing, reading tables and lists – this MCP
gives the agent structured data with SAP-aware safety rails at a fraction of the tokens. Web GUI in a
browser is the fallback where SAP GUI for Java is not installed, and the way to reach Fiori apps.
For debugging, neither works: use ADT (the ABAP Development Tools) with external breakpoints – which is
also what SAP's message in Web GUI recommends.

## Requirements

- SAP GUI for Java (tested: 8.10, Linux) – found automatically via `scripts/sapgui-home`
  (`$SAPGUI_HOME`, `~/SAPClients/SAPGUI*`, `/opt/SAPClients/SAPGUI*`).
- Node.js 20+ and Claude Code (or any MCP client).
- A JDK 17+ to build the bridge agent – the one shipped with SAP GUI is used if present.
- An ABAP system with scripting allowed (`sapgui/user_scripting`); the
  [ABAP Cloud Developer Trial](https://hub.docker.com/r/sapse/abap-cloud-developer-trial) works.

## Quick start

```
git clone https://github.com/christianguenter2/sapgui-java-mcp.git && cd sapgui-java-mcp
(cd mcp && npm install && npm run build)
claude mcp add --scope user sapgui-java -- node "$PWD/mcp/dist/index.js"
mkdir -p ~/.sapgui-java-mcp && echo '{"allowedSystems": ["A4H/001"]}' > ~/.sapgui-java-mcp/config.json
scripts/install-autostart.sh        # launcher "SAP GUI (MCP bridge)"
```

Start SAP GUI with **"SAP GUI (MCP bridge)"**, log on (system and client must be in `allowedSystems`),
then ask Claude e.g. *"show table T000 in SE16"*. Details below.

## Setup

### 1. Enable scripting

- Server: profile parameter `sapgui/user_scripting = TRUE` (RZ11). A connection opened *before* the
  change stays disabled – log on again.
- Client: SAP GUI for Java → Options → *Scripting* → enable scripting.

### 2. Start the bridge – automatically (recommended)

```
scripts/install-autostart.sh      # builds agent/bridge-agent.jar, adds launcher "SAP GUI (MCP bridge)"
```

Start SAP GUI with the new launcher **"SAP GUI (MCP bridge)"**. It runs `guilogon` with
`PLATIN_JAVA=scripts/sapgui-java-with-bridge`, which adds
`-javaagent:agent/bridge-agent.jar=scripts/bridge.js` to SAP GUI's JVM. The agent waits until the GUI
is up and runs `bridge.js` through the GUI's own script interpreter (as the Scripting menu does) –
already before logon; no dialog; log in `~/.sapgui-java-mcp/agent.log`. Your original launcher is
unchanged; remove the new one with `rm ~/.local/share/applications/sapgui-mcp-bridge.desktop`.

Into an already running GUI (without restart):
`"$(scripts/sapgui-home)/jre/bin/java" -jar agent/bridge-agent.jar <pid> scripts/bridge.js`
(a second attach into the same JVM runs the agent class loaded first).

**Manually instead:** run `scripts/bridge.js` from the Scripting menu once per GUI start (dialog
"bridge … listening on 127.0.0.1:<port>"). For `sap_reload_bridge` you then need
`"bridgeScript": "<repo>/scripts/bridge.js"` in `~/.sapgui-java-mcp/config.json` (Nashorn `__FILE__`
is null when started from the menu; the auto-start agent passes the path itself).

After changing `bridge.js`: `sap_reload_bridge` (reloads every bridge) – no restart, no menu.

**Several SAP GUI processes.** Each logon started from the command line gets its own SAP GUI JVM; every
JVM started with the wrapper runs its own bridge, registered in `~/.sapgui-java-mcp/bridges/<pid>.json`.
The MCP server talks to all of them. To start your own logon script with the bridge, export
`PLATIN_JAVA=<repo>/scripts/sapgui-java-with-bridge` before it calls `guistart` / `guilogon`.

### 3. MCP server

```
cd mcp && npm install && npm run build
claude mcp add --scope user sapgui-java -- node "$PWD/dist/index.js"
```

After each rebuild: `/mcp` → reconnect. Env: `SAPGUI_BRIDGE_DIR` (default `~/.sapgui-java-mcp`),
`SAPGUI_BRIDGE_TIMEOUT_MS` (default 60000).

## Tools

Every tool takes an optional `system` (`SID/client`, e.g. `A4H/001`) and `session`. **Default: the
agent's own session of that system**, opened next to one of your sessions of the system on the first
call (`createSession`, so in the right SAP GUI process) and reopened if it was closed; your sessions
stay yours. Without `system`: the only system logged on, else `defaultSystem` from `config.json`, else
the system used last. Passing `session` explicitly hands a session over; with several SAP GUI processes
use the reference from `sap_status` (`<pid>/con[0]/ses[1]`). Action tools return the resulting
screen incl. status bar and pop-up, so no extra `sap_screen` call is needed. `sap_set_fields`,
`sap_press`, `sap_send_key`, `sap_send_command`, `sap_grid_action` and `sap_tree_action` also take
`expect` (screen guard) and `confirm` (write gate).

| Tool | Purpose |
|---|---|
| `sap_status` | every SAP GUI process with a bridge, its connections and sessions (references, `(user)` / `← agent session for SID/client`), input formats once known |
| `sap_screen` | the current screen (`view`, `includeMenus`, `maxNodes` default 400) |
| `sap_start_transaction` | start a transaction (`tcode`); checked against `deniedTransactions` |
| `sap_set_fields` | set text/checkbox/radio/combo values (`fields: [{id, value, by?, submit?}]`), also input fields and combo boxes inside controls (SE80 object type and name; `submit` = Enter in the field); optional `then` (`"Enter"`, `"Execute"`, … or `{press: id}`) – one call per input step |
| `sap_press` | press a button, select a tab / menu entry / radio button (`id`); on a list line (`lbl[col,row]`) or field: cursor + double-click; toolbar controls (`control=SapToolBarWrapper`, buttons listed in the screen): `button` + `menuItem` for menu buttons (without it the entries are listed) |
| `sap_send_key` | named key (Enter, Back, Execute, Save, Cancel, PageDown, …) or numeric VKey; optional `window` |
| `sap_send_command` | OK-code (`command`, e.g. `/nSE16N`) |
| `sap_read_grid` | ALV grid rows (`id`, `firstRow`, `maxRows` default 50, `columns`) plus toolbar ids, selected rows, current cell; waits for lazily loaded rows and warns about rows that stayed empty |
| `sap_grid_action` | ALV grid: `setCurrentCell`, `click`, `doubleClick`, `pressButton` (row + technical column), `selectRows` (`"0,2-4"`), `selectAll`, `clearSelection`, `pressColumnHeader`, `pressToolbar` (button id), `pressToolbarContext` / `selectToolbarMenuItem`; context menu: `contextMenu` (row + column or current cell), `selectContextMenuItem` (`menuItem` = code or `menuText`), `closeContextMenu` |
| `sap_read_table` | dynpro table control rows (`id`, `firstRow`, `maxRows` default 50, `columns`, `skipEmpty` default true); cell ids usable with `sap_set_fields` |
| `sap_read_text` | text editor (long texts, notes) or ABAP editor (SE38/SE24/SE37 source): numbered lines (1-based) by range, read-only/modified state; the screen shows these controls only as `lines=N` |
| `sap_set_text` | change a text or ABAP editor: whole text, lines `fromLine`..`toLine`, or `insertBefore` a line; refused in display mode; saving stays a separate, gated step |
| `sap_read_list` | classic list output (WRITE lists, SE16 results, report output: `lbl[col,line]` …) as a table – one column per cell start position, title lines as text, PageDown hint; ~95 % smaller than `view=full` |
| `sap_read_tree` | tree nodes (`id`, `maxNodes` default 300): key, parent, folder state, text; list/column trees with their item columns |
| `sap_tree_action` | tree by node key: `select`, `expand`, `collapse`, `doubleClick`, `selectItem`, `doubleClickItem`, `clickLink`, `pressButton`, `checkbox`, `unselectAll`; context menu: `nodeContextMenu`, `itemContextMenu`, `headerContextMenu`, `defaultContextMenu`, `selectContextMenuItem`, `closeContextMenu` |
| `sap_screenshot` | PNG of the active window (or `window`, e.g. `wnd[1]`), returned as an image plus the saved path |
| `sap_user_formats` | the user's date format, decimal notation, time format (SU3 defaults, read in a separate session that is closed again; cached) |
| `sap_open_session` | open a new agent session for a `system` and make it that system's default (normally automatic) |
| `sap_close_session` | close the agent session (sessions the agent did not open are refused) |
| `sap_reload_bridge` | reload `bridge.js` in every SAP GUI process and wait until each new bridge answers |

### Screen views (`view`)

- `compact` – default for `sap_screen` and for a newly reached screen: one line per toolbar (standard
  toolbar reduced to Enter/Save/Back/Exit/Cancel), ids grouped by container, labels merged into their
  field, only deviations flagged (`ro`, `req`); no OK-code field, title/menu bar, group frames or empty
  read-only fields.
- `changed` – default for actions: only elements new or changed on the same window/program/dynpro.
- `status` – header, status bar and pop-up only. `full` – everything.

Typical savings on a large entry screen: `compact` −70 %, `changed` after Enter −90 % or more compared with `full`.

### Screen guard (`expect`)

`expect: "SAPLSE16N/120"` (as in the screen header, optionally `"SE16H SAPLSE16N/120 wnd[1]"`) or
`{program, screen, window, transaction}`. Checked on the bridge's request thread right before the
action; if the session is elsewhere → HTTP 409, nothing done:

```
screen guard: program SAPLSE16N ≠ SAPLSMTR_NAVIGATION, screen 120 ≠ 100 – nothing was done.
Session is on SESSION_MANAGER SAPLSMTR_NAVIGATION/100 wnd[0] "SAP Easy Access"
```

While a pop-up (`wnd[1]` …) is active, actions on elements of a window behind it are refused
("answer or close it first"); reading stays possible. Every error names the current screen.

### Write gate (`confirm`)

Refused with HTTP 428 unless the request has `confirm: true` **and** `expect`:
- Save/Post: vkey 11, `tbar[0]/btn[11]`, buttons/menu entries whose text or tooltip starts with
  Save/Post/Buchen/Sichern/Speichern, OK-codes `=BU =SAVE =SICH =SPEI =POST =UPDA /11` (also typed into
  the OK-code field + Enter);
- keys bound to such a function on the current screen: for any F-key (Shift/Ctrl combinations too)
  the gate reads the toolbar button and menu entries the key triggers (e.g. Shift+F2 = "Delete…");
  buttons and menu entries bound to Ctrl+S are Save in any logon language; toolbar control buttons and
  their menu entries like ALV toolbar buttons;
- actions that commit at once: buttons/menu entries Close/Release/Reverse/Delete (+ German);
  Yes or Enter in a pop-up whose question is about saving, posting, closing, deleting, reversing,
  releasing or creating; ALV toolbar buttons, toolbar menu entries and grid/tree context menu entries
  that save/delete/post/release.

"No" to "Save changes?", "Cancel" and "Continue" stay free. Every write is logged in `bridge.log`
(`writeAction`). Disable with `"confirmWrites": false`.

### Pop-ups

Modal windows produce a POPUP block: title, texts (incl. the HTML text of SPO1 confirmations, read
from the GUI's browser control) and the answer buttons with their ids. Outline §8.

### Table controls

Cell ids are `<table>/<cell>[col,visibleRow]` (row relative to the scroll position). The number of
data rows is the vertical scrollbar maximum; rows outside the visible page are read by scrolling.
Column titles are corrected for reordered line layouts. Outline §7.

## Configuration and files

`~/.sapgui-java-mcp/` (dir 700, files 600):

- `config.json` (optional):
  - `allowedSystems` – `["SID/client", …]`, **required**: without it the bridge refuses every session (bridge)
  - `readOnly` – `true` rejects all write actions, default `false` (bridge)
  - `confirmWrites` – default `true`: write gate on (bridge)
  - `bridgeScript` – path of `bridge.js`; only needed for reload when started from the Scripting menu (bridge)
  - `deniedTransactions` – tcodes `sap_start_transaction` refuses, e.g. `["SU01"]` (MCP server)
  - `ownSession` – default `true`: tools without `session` use the agent's own session (MCP server)
  - `defaultSystem` – `SID/client` used when several systems are logged on and no `system` is given (MCP server)
- `bridges/<pid>.json` – port + token of each running bridge (one per SAP GUI process); stale ones are removed
- `bridge.json` – the most recently started bridge (for `scripts/sgb`)
- `bridge.log` – JSONL audit of write actions, reloads and errors
- `agent.log` – auto-start agent
- `screenshots/` – PNGs from `sap_screenshot` (last 20 kept). They show whatever is on screen, incl. the status bar with system and host – keep them out of repositories and tickets you share.

```
{"allowedSystems": ["DEV/100"], "deniedTransactions": ["SU01"]}
```

## Security

- The bridge listens on 127.0.0.1 only, random port; every request needs `Authorization: Bearer
  <token>` from `bridge.json`. Requests are processed one at a time.
- No generic eval endpoint, by design. `/reload` only loads the fixed bridge file (agent path,
  `__FILE__` or `bridgeScript`), never a path from the request.
- Systems outside `allowedSystems` are refused; `readOnly` and SAP's read-only scripting mode block
  writes; the write gate needs `confirm` + `expect`; the bridge never closes a session it did not open.

## Testing without Claude

MCP level – several calls in one server session (state such as `view=changed` and the agent session
carries over):

```
cd mcp
node dist/smoke.js                                             # sap_status
node dist/smoke.js sap_screen '{"view":"full"}'
node dist/smoke.js sap_screen '{}' sap_send_key '{"key":"Enter"}'
SMOKE_QUIET=1 node dist/smoke.js sap_screen '{"view":"compact"}'   # sizes only
```

Bridge level: `scripts/sgb <endpoint> '<json>'` with endpoints `status`, `screen`, `set`, `press`,
`vkey`, `tcode`, `command`, `grid`, `grid_action`, `table`, `tree`, `tree_action`, `session_open`,
`session_close`, `screenshot`, `list`, `reload`, `stop`. Action endpoints return the resulting screen unless
`{"returnScreen": false}`; without `session` the bridge uses `con[0]/ses[0]`.

```
scripts/sgb status
scripts/sgb tcode '{"session":"con[0]/ses[1]","tcode":"SE16N"}'
scripts/sgb grid  '{"id":"wnd[0]/shellcont/shell","maxRows":10}'
scripts/sgb vkey  '{"vkey":0,"expect":{"program":"SAPLSE16N","screen":120}}'
scripts/sgb reload
```

First-time diagnostics: `scripts/sgj-smoke-test.js` from the Scripting menu writes
`~/sapgui-java-smoke-test.txt` (session info, tree walk, threading, loopback socket).

## Tests

```
cd mcp && npm test        # build + unit tests (node:test): views, id splitting, expect, list tables,
                          # session refs, and the write-gate patterns read straight from bridge.js
```

CI (GitHub Actions) runs the unit tests, syntax checks of the bridge and the shell scripts, compiles
the bridge agent and checks that bridge, MCP server and changelog carry the same version.

**Live regression test** (needs a logged-on SAP GUI with the bridge; not in CI):

```
cd mcp && npm run test:live -- --system DEV/100 [--abap-program ZMY_PROGRAM]
```

It drives the MCP server like an agent in its own session, with standard objects only and without
saving anything: version check, Easy Access tree + context menu + write gate on "Delete All
Favorites", screen guard and Save gate, table display (SE16H or S416H, T000): text field, checkbox
and selection table control, then the ALV grid + context menu; ABAP editor in display mode (RSPARAM:
read, write refused; Shift+F2 = Delete gated), TextEdit (`SAPTEXTEDIT_DEMO_1`), classic list
(`SHOWCOLO`), radio buttons (SE38), user formats (SU3), SE80 (object type and name controls, toolbar
buttons and menus), an agent session ended by SAP (`/i`), screenshot. `--abap-program` (a program of
your own, e.g. in `$TMP`) adds the change-mode test: a line is inserted, Check must report it, the
editor is left with "No".
Prints PASS/FAIL per step and the call log on failure; exit code 1 on any failure.

## Status

Experimental, in use against development and trial systems since 2026-11-04. History and findings:
[docs/mcp-outline.md](docs/mcp-outline.md) §7–§23.

## License

[MIT](LICENSE) © 2026 Christian Guenter. SAP, SAP GUI and ABAP are trademarks of SAP SE; this project
is not affiliated with SAP SE.
