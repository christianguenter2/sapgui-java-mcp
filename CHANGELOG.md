# Changelog

All notable changes. Versions follow the bridge (`scripts/bridge.js`), the MCP server
(`mcp/package.json`) and this file in lockstep; CI checks that they match.

## [0.14.0] – 2026-11-05

### Added
- Toolbar controls (`SapToolBarWrapper` – SE80, editors, newer transactions): the screen lists their
  buttons (id = function code, text, menu/disabled/checked); `sap_press` with `button` presses one,
  with `menuItem` picks an entry of a menu button (validated against the menu); a menu button
  without `menuItem` returns its entries. Buttons and menu entries that save/delete/post are gated.
- Input fields and combo boxes inside controls (`SapInputFieldWrapper`, `SapComboBoxWrapper` – e.g.
  SE80 object type and name): `sap_set_fields` sets them (combo by key or `by: "value"`, unknown
  entries refused with the list), `submit: true` submits an input field and returns the screen.
- Live test: SE80 step (object type + name, object list, toolbar buttons and menu, gate).

## [0.13.0] – 2026-11-05

### Changed
- Write gate: every virtual key is checked for what it triggers on the current screen – the toolbar
  button `btn[<vkey>]` and the menu entries whose accelerator is that key – so a program's F5 =
  "Post" or Shift+F2 = "Delete…" needs `confirm` + `expect` like Save (Enter: toolbar button only).
- Write gate: buttons and menu entries bound to Ctrl+S count as Save whatever their text (logon
  languages other than English/German).
- `sap_send_key` names Shift+F1…F12, Ctrl+F1…F12, Ctrl+Shift+F1…F12 (vkeys 13–48).
- Live test: Shift+F2 (Delete…) on SE38, menu Program > Save in change mode.

## [0.12.0] – 2026-11-05

### Added
- `sap_read_text` / `sap_set_text` for text editors (`SapTextEditWrapper`) and the ABAP editor
  (`SapAbapEditorWrapper`): numbered lines by range; replace the whole text, a line range, or insert
  before a line. Refused when the editor is read-only (display mode) – the ABAP editor would
  otherwise take the text locally. Saving stays a separate, gated step.

### Changed
- Screen summaries show editors as `lines=N` (+ ro / editable / modified) instead of the whole text.
- An action that ends the session (e.g. Exit from a transaction, `/i`) reports that clearly instead
  of a Java exception; the MCP server forgets that agent session, and a call that hit an already
  closed agent session is retried once in a new one (it went to the stale session before). The bridge
  drops ids of closed agent sessions, so a new user session that gets the same id is not taken for
  the agent's.
- `npm run test:live` – live regression test against a logged-on SAP GUI (see README → Tests).
- `mcp/package-lock.json` carries the package version again.

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
