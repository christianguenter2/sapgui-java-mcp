// Compact text rendering of bridge results (saves tokens vs. raw JSON)

export interface Element {
  id: string; type: string; text?: string; tooltip?: string; changeable?: boolean;
  selected?: boolean; key?: string; required?: boolean; control?: string; subtype?: string;
  rowCount?: number; title?: string; html?: string; htmlError?: string;
}
export interface Popup { title: string; texts: string[]; buttons: { id: string; text: string }[] }
export interface Screen {
  session: { id: string; system: string; client: string; user: string; transaction: string; program: string; screen: number };
  activeWindow: string;
  windows: { id: string; type: string; title: string }[];
  elements: Element[];
  statusBar: { type: string; text: string; id: string; number: string } | null;
  truncated: boolean;
  popup?: Popup;
}

export function formatPopup(p: Popup): string[] {
  const lines = [`POPUP ${q(p.title)} – read before answering:`];
  const seen = new Set<string>();
  for (const t of p.texts) {
    if (seen.has(t)) continue;
    seen.add(t);
    for (const l of t.split("\n")) lines.push(`  | ${l}`);
  }
  if (!p.texts.length) lines.push("  | (no text found – check the elements below)");
  if (p.buttons.length) lines.push("  answers: " + p.buttons.map(b => `${q(b.text)}=${b.id}`).join(", "));
  return lines;
}

const INPUTS = new Set(["GuiTextField", "GuiCTextField", "GuiPasswordField", "GuiOKCodeField", "GuiComboBox"]);

function q(s: string | undefined): string { return s === undefined ? "" : JSON.stringify(s); }

export function formatElement(e: Element): string {
  const t = e.type.replace(/^Gui/, "");
  const parts = [e.id, t];
  if (INPUTS.has(e.type)) {
    parts.push(`value=${q(e.text ?? "")}`);
    if (e.type === "GuiComboBox" && e.key !== undefined) parts.push(`key=${q(e.key)}`);
  } else if (e.text) parts.push(q(e.text));
  if (e.tooltip) parts.push(`tip=${q(e.tooltip)}`);
  if (e.selected !== undefined) parts.push(e.selected ? "[x]" : "[ ]");
  if (e.changeable === true) parts.push("editable");
  if (e.changeable === false && INPUTS.has(e.type)) parts.push("readonly");
  if (e.required) parts.push("required");
  if (e.control) parts.push(`control=${e.control}${e.subtype ? "/" + e.subtype : ""}`);
  if (e.rowCount !== undefined) parts.push(`rows=${e.rowCount}`);
  if (e.title) parts.push(`title=${q(e.title)}`);
  if (e.html) parts.push(`html=${q(e.html.length > 300 ? e.html.slice(0, 300) + " …" : e.html)}`);
  if (e.htmlError) parts.push(`htmlErr=${q(e.htmlError)}`);
  return parts.join("  ");
}

export function formatScreen(s: Screen): string {
  const ses = s.session;
  const lines: string[] = [];
  const active = s.windows.find(w => w.id === s.activeWindow);
  lines.push(`${ses.system}/${ses.client} ${ses.user} | ${ses.transaction} ${ses.program}/${ses.screen} | active ${s.activeWindow}: ${q(active?.title)}`);
  if (s.windows.length > 1) lines.push("windows: " + s.windows.map(w => `${w.id} ${w.type.replace(/^Gui/, "")} ${q(w.title)}`).join("; "));
  const sb = s.statusBar;
  lines.push(sb && sb.text ? `status: [${sb.type || "-"}] ${sb.text}${sb.id ? ` (${sb.id}/${sb.number})` : ""}` : "status: (empty)");
  if (s.popup) lines.push(...formatPopup(s.popup));
  lines.push("elements (id  type  value/text  flags):");
  for (const e of s.elements) lines.push("  " + formatElement(e));
  if (s.truncated) lines.push("  … truncated – raise maxNodes");
  return lines.join("\n");
}

export interface Grid {
  id: string; title: string; rowCount: number; firstRow: number; returned: number;
  columns: { name: string; title: string }[]; rows: Record<string, string>[];
}

export interface Table {
  id: string; title: string; rowCount: number; visibleRowCount: number; scrollPosition: number;
  dataRows?: number; scrolled: boolean; firstRow: number; lastRow: number; emptySkipped: number; endOfData?: boolean;
  scrollbar?: { position: number; maximum: number; pageSize: number } | null;
  columns: { index: number; idCol: number; name: string; title: string; type: string; idPrefix: string }[];
  rows: { row: number; visibleRow: number; cells: Record<string, string>; editable?: boolean; selected?: boolean }[];
}

export function formatTable(t: Table): string {
  const head = `table ${t.id}${t.title ? " " + q(t.title) : ""}: rows ${t.firstRow}..${t.lastRow} of ${t.dataRows ?? t.rowCount} data rows (${t.rowCount} lines)` +
    (t.emptySkipped ? `, ${t.emptySkipped} empty skipped` : "") +
    ` | scrolled to row ${t.scrollPosition}, ${t.visibleRowCount} visible${t.scrolled ? " (table was scrolled)" : ""}` +
    (t.endOfData ? " | end of data" : "") +
    (t.scrollbar ? ` | scrollbar max=${t.scrollbar.maximum} page=${t.scrollbar.pageSize}` : "");
  const keys = t.columns.map(c => c.name || `#${c.index}`);
  const lines = [
    head,
    "columns (col in cell id: field=title type): " +
      t.columns.map(c => `${c.idCol}:${c.name || "?"}=${q(c.title)} ${c.type}`).join(", "),
    `cell id = ${t.id}/<cell>[col,vis], cells: ` +
      t.columns.map(c => c.idPrefix.replace(t.id + "/", "")).join(", "),
    ["row", "vis", "flags", ...keys].join("\t"),
  ];
  for (const r of t.rows) {
    const flags = (r.editable ? "e" : "") + (r.selected ? "s" : "");
    lines.push([r.row, r.visibleRow, flags, ...keys.map(k => (r.cells[k] ?? "").replace(/[\t\n]/g, " "))].join("\t"));
  }
  if (t.lastRow + 1 < t.rowCount && !t.endOfData) lines.push(`… more rows: call again with firstRow=${t.lastRow + 1}`);
  lines.push("vis = visible row index used in cell ids; flags: e = editable, s = selected");
  return lines.join("\n");
}

export function formatGrid(g: Grid): string {
  const head = `grid ${g.id}${g.title ? " " + q(g.title) : ""}: rows ${g.firstRow}..${g.firstRow + g.returned - 1} of ${g.rowCount}`;
  const cols = g.columns.map(c => c.name);
  const lines = [head, "columns: " + g.columns.map(c => `${c.name}=${q(c.title)}`).join(", "), cols.join("\t")];
  for (const r of g.rows) lines.push(cols.map(c => (r[c] ?? "").replace(/[\t\n]/g, " ")).join("\t"));
  if (g.firstRow + g.returned < g.rowCount) lines.push(`… more rows: call again with firstRow=${g.firstRow + g.returned}`);
  return lines.join("\n");
}
