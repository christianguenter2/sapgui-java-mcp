# Changelog

All notable changes. Versions follow the bridge (`scripts/bridge.js`), the MCP server
(`mcp/package.json`) and this file in lockstep; CI checks that they match.

## [0.11.0] – 2026-11-05

### Added
- Context menus in ALV grids and trees: `sap_grid_action` `contextMenu` (on row + column or the
  current cell) and `sap_tree_action` `nodeContextMenu` / `itemContextMenu` / `headerContextMenu` /
  `defaultContextMenu` list the entries (function code, text, submenus, disabled/checked);
  `selectContextMenuItem` picks one by `menuItem` (code) or `menuText` (text or `"Submenu > Entry"`);
  an opener with `menuItem`/`menuText` opens and picks in one call; `closeContextMenu`.
- Write gate: context menu entries that save/delete/post/release need `confirm` + `expect`.

### Changed
- ALV codes that only change the view (`&DELETE_FILTER`, `&DELETE_SORT`) no longer trip the write gate.

## [0.10.0] – 2026-11-05

First public, **experimental** release. Tested on SAP GUI for Java 8.10 (Linux) against an
S/4HANA development system and the ABAP Cloud Developer Trial 2025.

### Reading
- `sap_screen` with views `compact` (default), `changed` (default after actions), `status`, `full`
  – about −70 % / −90 % tokens on large entry screens.
- Pop-ups: a POPUP block with the question (incl. the HTML text of SPO1 confirmations) and the answer
  buttons.
- `sap_read_table` – dynpro table controls, scrolling, correct column titles for reordered layouts.
- `sap_read_grid` – ALV grids incl. toolbar ids, selection, lazy-loaded rows.
- `sap_read_tree` – simple, list and column trees; texts the scripting API misses are read from the
  tree model.
- `sap_read_list` – classic list output (SE16, WRITE lists, report output) as a table.
- `sap_screenshot` – PNG of a window as image content.
- `sap_user_formats` – the user's date/number/time formats (SU3), in a separate session.

### Acting
- `sap_set_fields` (with `then`), `sap_press` (also double-click on list lines), `sap_send_key`,
  `sap_send_command`, `sap_start_transaction`.
- `sap_grid_action`, `sap_tree_action`.

### Safety
- The agent works in its **own session** per system; user sessions are never closed by it.
- Screen guard `expect`; actions behind an open pop-up are refused; errors name the current screen.
- Write gate `confirm`: Save/Post, committing buttons, Yes/Enter in confirmation pop-ups and ALV
  toolbar writes need `confirm` + `expect`. Heuristic – see the README.
- Mandatory `allowedSystems`, loopback + token, no eval endpoint, audit log.

### Operations
- Bridge auto-start with SAP GUI (Java agent + `PLATIN_JAVA` wrapper), no Scripting menu, no dialog.
- Several SAP GUI processes: one bridge per JVM, routed by the MCP server (`system`, session refs).
- `sap_reload_bridge` reloads every bridge in place.
