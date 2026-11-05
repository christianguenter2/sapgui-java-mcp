// Screen views: how much of a screen reaches the model.
//   full     – every element (formatScreen)
//   compact  – toolbars as one line, labels merged into their field, no empty read-only
//              fields / group frames / title & menu bar
//   changed  – only elements new or changed since the last screen of the same dynpro
//              (falls back to compact when window, program or dynpro differ)
//   status   – header, status bar and pop-up only
import { Element, Screen, formatElement, formatPopup, formatScreen } from "./format.js";

export type View = "full" | "compact" | "changed" | "status";
export const VIEWS = ["compact", "changed", "status", "full"] as const;

const INPUTS = new Set(["GuiTextField", "GuiCTextField", "GuiPasswordField", "GuiOKCodeField", "GuiComboBox"]);
// Java GUI type names (differ from the Windows API: ToolBar, MenuBar, StatusBar, GroupContainer)
const DROP_TYPES = new Set(["GuiMainWindow", "GuiModalWindow", "GuiTitleBar", "GuiMenuBar", "GuiMenubar", "GuiStatusBar", "GuiStatusbar", "GuiGroupContainer", "GuiBox"]);
const TOOLBAR_TYPES = new Set(["GuiToolBar", "GuiToolbar"]);
// type prefixes of SAP GUI element names: lblFOO, txtFOO, ctxtFOO, chkFOO …
const PREFIX = /^(lbl|txt|ctxt|chk|rad|cmb|pwd|btn|okcd|tbl|cntl|sub|tabs|tabp|shell|box)/;

function q(s: string | undefined): string { return s === undefined ? "" : JSON.stringify(s); }
// Segment separator in SAP GUI ids: a "/" followed by a lowercase type prefix (usr, tbl, txt, wnd[0] …).
// Names may contain namespace slashes – "tbl/XYZ/SAPLCFG_VTCTRL_/XYZ/CFG_V" is ONE segment –
// and those are followed by uppercase DDIC names, so they are not separators.
function lastSep(id: string): number {
  for (let i = id.length - 1; i > 0; i--) if (id[i] === "/" && /[a-z]/.test(id[i + 1] ?? "")) return i;
  return -1;
}
export const lastPart = (id: string) => id.slice(lastSep(id) + 1);
export const parentOf = (id: string) => { const i = lastSep(id); return i < 0 ? "" : id.slice(0, i); };
const baseName = (id: string) => lastPart(id).replace(PREFIX, "").replace(/\[\d+(,\d+)?\]$/, "");

function header(s: Screen): string[] {
  const ses = s.session;
  const active = s.windows.find(w => w.id === s.activeWindow);
  const lines = [`${ses.system}/${ses.client} ${ses.user} ${(ses as any).ref ?? ses.id.replace(/^\/app\/con\[\d+\]\//, "")} | ${ses.transaction} ${ses.program}/${ses.screen} | active ${s.activeWindow}: ${q(active?.title)}`];
  if (s.windows.length > 1) lines.push("windows: " + s.windows.map(w => `${w.id} ${w.type.replace(/^Gui/, "")} ${q(w.title)}`).join("; "));
  const sb = s.statusBar;
  lines.push(sb && sb.text ? `status: [${sb.type || "-"}] ${sb.text}${sb.id ? ` (${sb.id}/${sb.number})` : ""}` : "status: (empty)");
  if (s.popup) lines.push(...formatPopup(s.popup));
  return lines;
}

// standard toolbar buttons that rarely matter; listed only by count
const STD_NOISE = new Set(["btn[86]", "btn[71]", "btn[84]", "btn[80]", "btn[81]", "btn[82]", "btn[83]", "btn[74]", "btn[1]"]);
// input types whose kind is already encoded in the id prefix (txt, ctxt, chk, rad, cmb, pwd)
const IMPLIED_TYPE = new Set(["GuiTextField", "GuiCTextField", "GuiCheckBox", "GuiRadioButton", "GuiComboBox", "GuiPasswordField", "GuiButton", "GuiLabel"]);

/** One compact line for an element, id relative to its container. */
function compactElement(e: Element, label: string | undefined, tipToo: boolean): string {
  const parts = [lastPart(e.id)];
  if (INPUTS.has(e.type)) {
    parts.push(`=${q(e.text ?? "")}`);
    if (e.type === "GuiComboBox" && e.key !== undefined && e.key !== (e.text ?? "")) parts.push(`key=${q(e.key)}`);
  } else if (e.text && e.type !== "GuiCheckBox" && e.type !== "GuiRadioButton") parts.push(q(e.text.trim()));
  if (e.selected !== undefined) parts.push(e.selected ? "[x]" : "[ ]");
  if (!IMPLIED_TYPE.has(e.type)) parts.push(e.type.replace(/^Gui/, ""));
  if (e.changeable === false && (INPUTS.has(e.type) || e.type === "GuiCheckBox" || e.type === "GuiRadioButton")) parts.push("ro");
  if (e.required) parts.push("req");
  const txt = e.type === "GuiCheckBox" || e.type === "GuiRadioButton" ? e.text?.trim() : undefined;
  if (label) parts.push(q(label) + (tipToo && e.tooltip ? ` (${e.tooltip})` : ""));
  else if (txt) parts.push(q(txt));
  else if (e.tooltip && e.type !== "GuiButton") parts.push(`(${e.tooltip})`);
  else if (e.tooltip && e.type === "GuiButton" && !e.text) parts.push(`(${e.tooltip})`);
  if (e.control) parts.push(`control=${e.control}${e.subtype ? "/" + e.subtype : ""}`);
  if (e.rowCount !== undefined) parts.push(`rows=${e.rowCount}`);
  if (e.title) parts.push(`title=${q(e.title)}`);
  if (e.html) parts.push(`html=${q(e.html.length > 200 ? e.html.slice(0, 200) + " …" : e.html)}`);
  if (e.htmlError) parts.push(`htmlErr=${q(e.htmlError)}`);
  return parts.join(" ");
}

/** Compact element list: toolbar lines + elements grouped by container (labels merged). */
function compactLines(s: Screen, only?: Set<string>): { lines: string[]; shown: number } {
  const els = s.elements;
  // labels: lblNAME next to a field NAME in the same container → merged into the field line
  const fieldKeys = new Set<string>();
  for (const e of els) if (e.type !== "GuiLabel") fieldKeys.add(parentOf(e.id) + "/" + baseName(e.id));
  const labelFor = new Map<string, string>();
  const mergedLabels = new Set<string>();
  const labelCount = new Map<string, number>();
  for (const e of els) {
    if (e.type !== "GuiLabel" || !e.text) continue;
    const key = parentOf(e.id) + "/" + baseName(e.id);
    if (fieldKeys.has(key)) {
      const t = e.text.trim();
      labelFor.set(key, t); mergedLabels.add(e.id);
      labelCount.set(t, (labelCount.get(t) ?? 0) + 1);
    }
  }

  const toolbars = new Map<string, { shown: string[]; noise: number }>();
  const groups = new Map<string, string[]>();
  let shown = 0;
  for (const e of els) {
    if (only && !only.has(e.id)) continue;
    if (DROP_TYPES.has(e.type) || TOOLBAR_TYPES.has(e.type)) continue;
    if (mergedLabels.has(e.id)) continue;
    if (e.type === "GuiOKCodeField") continue; // always there; use sap_send_command
    const tb = /^(wnd\[\d+\]\/tbar\[\d+\])\/(btn\[\d+\])$/.exec(e.id);
    if (tb && e.type === "GuiButton") {
      if (!toolbars.has(tb[1])) toolbars.set(tb[1], { shown: [], noise: 0 });
      const t = toolbars.get(tb[1])!;
      if (tb[1].endsWith("tbar[0]") && STD_NOISE.has(tb[2])) t.noise++;
      else t.shown.push(`${tb[2]}=${(e.text || e.tooltip || "?").trim()}`);
      shown++;
      continue;
    }
    // empty read-only output fields carry no information
    if (INPUTS.has(e.type) && e.changeable === false && !e.text) continue;
    const key = parentOf(e.id) + "/" + baseName(e.id);
    const label = labelFor.get(key);
    const line = compactElement(e, label, !!label && (labelCount.get(label) ?? 0) > 1);
    const g = parentOf(e.id);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(line);
    shown++;
  }
  const lines: string[] = [];
  for (const [id, t] of toolbars) lines.push(`${id}: ${t.shown.join(", ")}${t.noise ? ` (+${t.noise} standard)` : ""}`);
  for (const [g, ls] of groups) { lines.push(`${g}/`); for (const l of ls) lines.push("  " + l); }
  return { lines, shown };
}

const sameDynpro = (a: Screen, b: Screen) =>
  a.activeWindow === b.activeWindow && a.session.program === b.session.program &&
  a.session.screen === b.session.screen && a.session.transaction === b.session.transaction;

// last screen per session, for view=changed
const last = new Map<string, Screen>();

export function renderScreen(s: Screen, view: View = "compact"): string {
  const key = (s.session as any).ref ?? s.session.id;   // unique across SAP GUI processes
  const prev = last.get(key);
  last.set(key, s);

  if (view === "full") return formatScreen(s);
  const head = header(s);
  if (view === "status") return head.join("\n");

  if (view === "changed" && prev && sameDynpro(prev, s)) {
    const before = new Map(prev.elements.map(e => [e.id, formatElement(e)]));
    const changed = new Set<string>();
    for (const e of s.elements) if (before.get(e.id) !== formatElement(e)) changed.add(e.id);
    const now = new Set(s.elements.map(e => e.id));
    const removed = prev.elements.filter(e => !now.has(e.id)).map(e => e.id);
    const { lines } = compactLines(s, changed);
    const out = [...head, `changed on this screen (${changed.size} of ${s.elements.length} elements; view=compact for all):`];
    out.push(...(lines.length ? lines : ["(nothing changed)"]));
    if (removed.length) out.push(removed.length <= 3
      ? `removed: ${removed.map(lastPart).join(", ")}`
      : `removed: ${removed.length} elements (e.g. another tab or subscreen was replaced)`);
    return out.join("\n");
  }

  const { lines } = compactLines(s);
  const out = [...head, `elements (compact; id = container + name; =value, ro = read-only, req = required, "label"; view=full for all):`, ...lines];
  if (s.truncated) out.push("  … truncated – raise maxNodes");
  return out.join("\n");
}
