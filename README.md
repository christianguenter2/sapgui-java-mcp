# sapgui-java-mcp

Goal: let Claude drive SAP GUI for Java (Linux) through the SAP GUI scripting API via MCP.

Architecture: Claude Code ⇄ MCP server (Node, stdio, `mcp/`) ⇄ HTTP on 127.0.0.1 ⇄
`scripts/bridge.js` (Nashorn, runs inside SAP GUI) ⇄ scripting API.
Design and findings: [docs/mcp-outline.md](docs/mcp-outline.md).

## Step 0 – smoke test (read-only)

1. Server side: profile parameter `sapgui/user_scripting = TRUE` on the target system (DEV: done 2026-11-04).
2. Client side: SAP GUI for Java → Options/Preferences → *Scripting* → enable scripting
   (and set the scripts directory to this repo's `scripts/` folder, or open the file in the script window).
3. Log on to DEV, open any transaction (better: one with an ALV list or tree, e.g. SE16N result or SE80).
4. Run `scripts/sgj-smoke-test.js` from the Scripting menu.
5. Result: `~/sapgui-java-smoke-test.txt` – answers the open questions in the outline §6.
   (Passed on DEV 2026-11-04.)

## Step 1 – bridge

1. Log on in SAP GUI for Java (a connection opened *after* scripting was enabled).
2. Run `scripts/bridge.js` from the Scripting menu once per GUI start → dialog
   "bridge … listening on 127.0.0.1:<port>". Running it again restarts the bridge; `sgb stop` stops it.
3. Later changes to `bridge.js`: `sap_reload_bridge` (MCP) or `scripts/sgb reload` – no Scripting menu needed.
   This requires `"bridgeScript"` in `~/.sapgui-java-mcp/config.json`, because Nashorn `__FILE__`
   is null when the script was started from the menu:

```
{"bridgeScript": "/home/<user>/Projects/GIT/sapgui-java-mcp/scripts/bridge.js"}
```

### Auto-start (no Scripting menu)

```
scripts/install-autostart.sh      # builds agent/bridge-agent.jar, adds launcher "SAP GUI (MCP bridge)"
```

The launcher starts `guilogon` with `PLATIN_JAVA=scripts/sapgui-java-with-bridge`, which adds
`-javaagent:agent/bridge-agent.jar=scripts/bridge.js` to SAP GUI's JVM. The agent waits for
`GuiApplication`, then runs `bridge.js` through the GUI's own script interpreter (as the Scripting
menu does) – before logon already; sessions are looked up per request. No start dialog; log in
`~/.sapgui-java-mcp/agent.log`. Into an already running GUI:
`~/SAPClients/SAPGUI8.10rev14/jre/bin/java -jar agent/bridge-agent.jar <pid> scripts/bridge.js`
(the JVM keeps the first loaded agent class, so a second attach runs the old agent code).
The original launcher is unchanged; remove the new one with
`rm ~/.local/share/applications/sapgui-mcp-bridge.desktop`.

## Step 2 – MCP server

```
cd mcp && npm install && npm run build
claude mcp add --scope user sapgui-java -- node "$PWD/dist/index.js"
```

Restart Claude Code (or `/mcp` → reconnect after each rebuild). The bridge must be running (step 1).

Env: `SAPGUI_BRIDGE_DIR` (default `~/.sapgui-java-mcp`), `SAPGUI_BRIDGE_TIMEOUT_MS` (default 60000).

## Tools

All tools take an optional `session`. Default: **the agent's own session** – opened automatically
next to the user's on the first call (`createSession`), reopened if it was closed; the user keeps
their session. Passing `session` explicitly (e.g. `con[0]/ses[0]`) hands a session over.
`"ownSession": false` in `config.json` restores the old default `con[0]/ses[0]`. Action tools return the resulting
screen incl. status bar, so no extra `sap_screen` call is needed. `sap_set_fields`, `sap_press`,
`sap_send_key` and `sap_send_command` also take `expect` (screen guard) and `confirm` (write gate), below.

| Tool | Purpose |
|---|---|
| `sap_status` | bridge version, connections, sessions (system/client/user/transaction) |
| `sap_screen` | read the current screen (`view`, `includeMenus`, `maxNodes` default 400) |
| `sap_start_transaction` | start a transaction (`tcode`); checked against `deniedTransactions` |
| `sap_set_fields` | set text/checkbox/radio/combo values (`fields: [{id, value, by?}]`); optional `then` (`"Enter"`, `"Execute"`, … or `{press: id}`) sends it afterwards and returns the screen – one call per input step |
| `sap_press` | press button, select tab / menu / radio (`id`) |
| `sap_send_key` | named key (Enter, Back, Execute, Save, Cancel, PageDown, …) or numeric VKey; optional `window` |
| `sap_send_command` | send an OK-code (`command`, e.g. `/nSE16N`) |
| `sap_read_grid` | ALV grid rows (`id`, `firstRow`, `maxRows` default 50, `columns`); scrolls and waits for lazily loaded rows, warns about rows that stayed empty |
| `sap_read_table` | dynpro table control rows (`id`, `firstRow`, `maxRows` default 50, `columns`, `skipEmpty` default true) |
| `sap_read_tree` | tree nodes (`id`, `maxNodes` default 300): key, parent, folder state, text; list/column trees with their item columns; texts the scripting API misses are read from the tree model |
| `sap_user_formats` | date format, decimal notation, time format of the user (SU3 defaults, read in a separate session that is closed again; cached) |
| `sap_open_session` | open a new agent session and make it the default (normally automatic) |
| `sap_close_session` | close the agent session (sessions the agent did not open are refused) |
| `sap_reload_bridge` | reload `bridge.js` inside SAP GUI and wait until the new bridge answers |

### Screen views (`view` parameter)

- `compact` – toolbars on one line, labels merged into their field, empty read-only fields,
  group frames, title and menu bar omitted. Default for `sap_screen`.
- `changed` – only elements new or changed since the last screen of the same dynpro; falls back to
  `compact` when window, program or dynpro differ. Default for action tools.
- `status` – header, status bar and pop-up only.
- `full` – every element; use when an element seems to be missing.

Measured on the ZPOST item screen: `full` 17.9k chars, `compact` 5.2k (−71 %),
`changed` after Enter 1.0k (−94 %).

### Screen guard (`expect` parameter)

`expect: "SAPLXYZ/200"` (as in the screen header, optionally `"ZPOST SAPLXYZ/200 wnd[1]"`) or
`{program, screen, window, transaction}`. The bridge checks it on its request thread right before the
action; if the session is elsewhere the action is refused with HTTP 409 and nothing is done:

```
screen guard: program SAPLXYZ ≠ SAPLSE16N, screen 202 ≠ 120 – nothing was done.
Session is on SE16H SAPLSE16N/120 wnd[0] "General Table Display"
```

Use it on every Save/Post and whenever the user may work in the same session. All other errors also
name the current screen (`element not found: … | session is on …`).

### Write gate (`confirm` parameter)

Save/Post – vkey 11 (Ctrl+S), `tbar[0]/btn[11]`, buttons whose text or tooltip starts with
Save/Post/Buchen/Sichern/Speichern, OK-codes `=BU`, `=SAVE`, `/11` … (also typed into the OK-code
field followed by Enter) – and actions that commit at once – buttons Close/Release/Reverse/Delete
(+ German), Yes or Enter in a pop-up whose question is about saving, posting, closing, deleting,
reversing, releasing or creating – are refused with HTTP 428 unless the request has `confirm: true`
**and** `expect`. "No" to "Save changes?" and "Continue" stay free. Every write is logged in `bridge.log` (`writeAction`). Disable with `"confirmWrites": false`.

```
write gate: press wnd[0]/tbar[0]/btn[11] "Save" saves data – nothing was done. Ask the user,
then repeat with confirm: true and expect (the current screen). Session is on SE16H SAPLSE16N/120 …
```

### Pop-ups

Modal windows (`wnd[1]`, `wnd[2]`) produce a POPUP block: title, texts (incl. the HTML text of SPO1
confirmations, read-only text fields, labels) and the answer buttons with their ids.
Details: outline [§8](docs/mcp-outline.md#8-pop-up-text-and-bridge-reload--findings-2026-11-04).

### Table controls

`sap_read_table` returns column names/titles and cell values. Cell ids are
`<table>/<cell>[col,visibleRow]` (row relative to the scroll position) and can be passed to
`sap_set_fields`. The number of data rows is the vertical scrollbar maximum; rows outside the visible
page are read by scrolling. Column titles are corrected for reordered line layouts.
Details: outline [§7](docs/mcp-outline.md#7-table-controls-table-sap_read_table--findings-2026-11-04).

## Configuration and files

`~/.sapgui-java-mcp/` (dir 700, files 600):

- `config.json` (optional):
  - `allowedSystems` – `["SID/client", …]`, default `["DEV/100"]` (bridge)
  - `readOnly` – `true` rejects all write actions, default `false` (bridge)
  - `deniedTransactions` – tcodes `sap_start_transaction` refuses, e.g. `["SU01"]` (MCP server)
  - `bridgeScript` – absolute path of `bridge.js`, needed for reload
  - `confirmWrites` – default `true`: Save/Post need `confirm` + `expect` (bridge)
  - `ownSession` – default `true`: tools without `session` use the agent's own session (MCP server)
- `bridge.json` – port + token, rewritten on every bridge start, deleted on `/stop`
- `bridge.log` – JSONL audit of all write actions and errors

```
{"allowedSystems": ["DEV/100"], "readOnly": false, "deniedTransactions": ["SU01"],
 "bridgeScript": "/home/<user>/Projects/GIT/sapgui-java-mcp/scripts/bridge.js"}
```

## Security

- Bridge listens on 127.0.0.1 only, random port; every request needs `Authorization: Bearer <token>`
  from `bridge.json` (mode 600).
- No generic eval endpoint, by design. `/reload` only loads the fixed bridge file
  (`__FILE__` or `bridgeScript`), never a path from the request.
- Systems outside `allowedSystems` are refused; `readOnly` and SAP's own read-only scripting mode
  block write actions.
- Requests are processed one at a time.

## Testing without Claude

MCP level (one server session, so `view=changed` state carries over between calls):

```
cd mcp
node dist/smoke.js                                   # sap_status
node dist/smoke.js sap_screen '{"view":"full"}'
node dist/smoke.js sap_screen '{}' sap_send_key '{"key":"Enter"}'
SMOKE_QUIET=1 node dist/smoke.js sap_screen '{"view":"compact"}'   # sizes only
```

Bridge level with `scripts/sgb <endpoint> '<json>'`; endpoints `status`, `screen`, `set`, `press`,
`vkey`, `tcode`, `command`, `grid`, `table`, `tree`, `reload`, `stop`:

```
scripts/sgb status
scripts/sgb screen
scripts/sgb tcode '{"tcode":"SE16N"}'
scripts/sgb set   '{"id":"wnd[0]/usr/ctxtGD-TAB","value":"T000"}'
scripts/sgb vkey  '{"vkey":8}'
scripts/sgb grid  '{"id":"<grid id from screen>","maxRows":10}'
scripts/sgb table '{"id":"<table control id from screen>","maxRows":20}'
scripts/sgb reload
```

Action endpoints return the resulting screen unless `{"returnScreen": false}`.

## Status / next

Phases and open items: [docs/mcp-outline.md §5](docs/mcp-outline.md#5-phases).
