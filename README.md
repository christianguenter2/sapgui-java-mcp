# sapgui-java-mcp

Lets Claude drive **SAP GUI for Java on Linux** through the SAP GUI scripting API, via MCP.

```
Claude Code ⇄ MCP server (Node, stdio, mcp/) ⇄ HTTP 127.0.0.1 + token ⇄ scripts/bridge.js (Nashorn, inside SAP GUI) ⇄ scripting API
```

The agent works in **its own SAP GUI session** next to yours, every Save/Post needs an explicit
confirmation, and screens come back in a compact, token-saving form. Design notes and everything
learned on the way (with dates): [docs/mcp-outline.md](docs/mcp-outline.md).

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
`~/SAPClients/SAPGUI8.10rev14/jre/bin/java -jar agent/bridge-agent.jar <pid> scripts/bridge.js`
(a second attach into the same JVM runs the agent class loaded first).

**Manually instead:** run `scripts/bridge.js` from the Scripting menu once per GUI start (dialog
"bridge … listening on 127.0.0.1:<port>"). For `sap_reload_bridge` you then need
`"bridgeScript": "<repo>/scripts/bridge.js"` in `~/.sapgui-java-mcp/config.json` (Nashorn `__FILE__`
is null when started from the menu; the auto-start agent passes the path itself).

After changing `bridge.js`: `sap_reload_bridge` (or `scripts/sgb reload`) – no restart, no menu.

### 3. MCP server

```
cd mcp && npm install && npm run build
claude mcp add --scope user sapgui-java -- node "$PWD/dist/index.js"
```

After each rebuild: `/mcp` → reconnect. Env: `SAPGUI_BRIDGE_DIR` (default `~/.sapgui-java-mcp`),
`SAPGUI_BRIDGE_TIMEOUT_MS` (default 60000).

## Tools

Every tool takes an optional `session`. **Default: the agent's own session**, opened next to yours on
the first call (`createSession`) and reopened if it was closed; your sessions stay yours. Passing
`session` explicitly (e.g. `con[0]/ses[0]`) hands a session over. Action tools return the resulting
screen incl. status bar and pop-up, so no extra `sap_screen` call is needed. `sap_set_fields`,
`sap_press`, `sap_send_key`, `sap_send_command`, `sap_grid_action` and `sap_tree_action` also take
`expect` (screen guard) and `confirm` (write gate).

| Tool | Purpose |
|---|---|
| `sap_status` | bridge version, connections, sessions – marked `(user)` / `← agent session (default)` – and the user's input formats once known |
| `sap_screen` | the current screen (`view`, `includeMenus`, `maxNodes` default 400) |
| `sap_start_transaction` | start a transaction (`tcode`); checked against `deniedTransactions` |
| `sap_set_fields` | set text/checkbox/radio/combo values (`fields: [{id, value, by?}]`); optional `then` (`"Enter"`, `"Execute"`, … or `{press: id}`) – one call per input step |
| `sap_press` | press a button, select a tab / menu entry / radio button (`id`); on a list line (`lbl[col,row]`) or field: cursor + double-click |
| `sap_send_key` | named key (Enter, Back, Execute, Save, Cancel, PageDown, …) or numeric VKey; optional `window` |
| `sap_send_command` | OK-code (`command`, e.g. `/nSE16N`) |
| `sap_read_grid` | ALV grid rows (`id`, `firstRow`, `maxRows` default 50, `columns`) plus toolbar ids, selected rows, current cell; waits for lazily loaded rows and warns about rows that stayed empty |
| `sap_grid_action` | ALV grid: `setCurrentCell`, `click`, `doubleClick`, `pressButton` (row + technical column), `selectRows` (`"0,2-4"`), `selectAll`, `clearSelection`, `pressColumnHeader`, `pressToolbar` (button id), `pressToolbarContext` / `selectToolbarMenuItem` |
| `sap_read_table` | dynpro table control rows (`id`, `firstRow`, `maxRows` default 50, `columns`, `skipEmpty` default true); cell ids usable with `sap_set_fields` |
| `sap_read_tree` | tree nodes (`id`, `maxNodes` default 300): key, parent, folder state, text; list/column trees with their item columns |
| `sap_tree_action` | tree by node key: `select`, `expand`, `collapse`, `doubleClick`, `selectItem`, `doubleClickItem`, `clickLink`, `pressButton`, `checkbox`, `unselectAll` |
| `sap_screenshot` | PNG of the active window (or `window`, e.g. `wnd[1]`), returned as an image plus the saved path |
| `sap_user_formats` | the user's date format, decimal notation, time format (SU3 defaults, read in a separate session that is closed again; cached) |
| `sap_open_session` | open a new agent session and make it the default (normally automatic) |
| `sap_close_session` | close the agent session (sessions the agent did not open are refused) |
| `sap_reload_bridge` | reload `bridge.js` inside SAP GUI and wait until the new bridge answers |

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
- actions that commit at once: buttons/menu entries Close/Release/Reverse/Delete (+ German);
  Yes or Enter in a pop-up whose question is about saving, posting, closing, deleting, reversing,
  releasing or creating; ALV toolbar buttons and toolbar menu entries that save/delete/post/release.

"No" to "Save changes?", "Cancel" and "Continue" stay free. Every write is logged in `bridge.log`
(`writeAction`). Not covered yet: context menus. Disable with `"confirmWrites": false`.

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
- `bridge.json` – port + token, rewritten on every bridge start, deleted on `/stop`
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
`session_close`, `screenshot`, `reload`, `stop`. Action endpoints return the resulting screen unless
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

## Status

In use against a development system since 2026-11-04. Open: context menus (grid/tree), text edit /
ABAP editor controls, automated tests and CI. History and findings:
[docs/mcp-outline.md](docs/mcp-outline.md) §7–§14.
