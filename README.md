# sapgui-java-mcp

Goal: let Claude drive SAP GUI for Java (Linux) through its scripting API via MCP.
Design: [docs/mcp-outline.md](docs/mcp-outline.md).

## Step 0 – smoke test (read-only)

1. Server side: `sapgui/user_scripting = TRUE` on the target system (DEV: done 2026-11-04).
2. Client side: SAP GUI for Java → Options/Preferences → *Scripting* → enable scripting
   (and set the scripts directory to this repo's `scripts/` folder, or open the file in the script window).
3. Log on to DEV, open any transaction (better: one with an ALV list or tree, e.g. SE16N result or SE80).
4. Run `scripts/sgj-smoke-test.js` from the Scripting menu.
5. Result: `~/sapgui-java-smoke-test.txt` – share it; it answers the open questions in the outline §6.
   (Passed on DEV 2026-11-04.)

## Step 1 – bridge (phase 1)

1. Log on to DEV in SAP GUI for Java (a connection opened *after* scripting was enabled).
2. Run `scripts/bridge.js` from the Scripting menu → dialog "bridge … listening on 127.0.0.1:<port>".
   Running it again restarts the bridge; `sgb stop` stops it.
3. Talk to it with `scripts/sgb`:

```
scripts/sgb status
scripts/sgb screen
scripts/sgb tcode '{"tcode":"SE16N"}'
scripts/sgb set   '{"id":"wnd[0]/usr/ctxtGD-TAB","value":"T000"}'
scripts/sgb vkey  '{"vkey":8}'
scripts/sgb grid  '{"id":"<grid id from screen>","maxRows":10}'
scripts/sgb table '{"id":"<table control id from screen>","maxRows":20}'
```

Files in `~/.sapgui-java-mcp/` (dir 700, files 600):
- `bridge.json` – port + token (deleted on `/stop`)
- `bridge.log` – JSONL audit of all write actions and errors
- `config.json` (optional) – `"bridgeScript": "<repo>/scripts/bridge.js"` enables `sap_reload_bridge` / `sgb reload`
  (reload after changing bridge.js without the Scripting menu); `{"allowedSystems": ["DEV/100"], "readOnly": false, "deniedTransactions": ["SU01"]}`;
  default allows only DEV/100. `allowedSystems`/`readOnly` are enforced by the bridge,
  `deniedTransactions` by the MCP server.

## Step 2 – MCP server (phase 2)

```
cd mcp && npm install && npm run build
claude mcp add --scope user sapgui-java -- node "$PWD/dist/index.js"
```

Restart Claude Code; the bridge must be running in SAP GUI (step 1).

Tools: `sap_status`, `sap_screen`, `sap_start_transaction`, `sap_set_fields`, `sap_press`,
`sap_send_key` (named keys Enter/Back/Execute/Save/… or numeric VKey), `sap_send_command`,
`sap_read_grid`, `sap_read_table`, `sap_read_tree`, `sap_reload_bridge`. Every action returns the resulting screen incl. status bar
as compact text.

Test without Claude: `cd mcp && node dist/smoke.js sap_screen '{}'`.

Env: `SAPGUI_BRIDGE_DIR` (default `~/.sapgui-java-mcp`), `SAPGUI_BRIDGE_TIMEOUT_MS` (default 60000).
