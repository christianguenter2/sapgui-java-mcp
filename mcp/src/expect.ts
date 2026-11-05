// Screen guard argument: "SAPLSE16N/120", optionally with transaction and window ("SE16H SAPLSE16N/120 wnd[1]"),
// or an object {program, screen, window, transaction}. Unparseable input is refused, so the guard fails safe.
import { BridgeError } from "./bridge.js";

export type Expect = { program?: string; screen?: number; window?: string; transaction?: string };
export function parseExpect(x: string | Expect | undefined): Expect | undefined {
  if (x === undefined) return undefined;
  if (typeof x !== "string") return x;
  const r: Expect = {};
  for (const tok of x.trim().split(/\s+/)) {
    const m = /^([A-Z0-9_\/]+)\/(\d+)$/i.exec(tok);
    if (m) { r.program = m[1]; r.screen = Number(m[2]); }
    else if (/^wnd\[\d+\]$/.test(tok)) r.window = tok;
    else if (tok) r.transaction = tok;
  }
  if (r.program === undefined && r.window === undefined && r.transaction === undefined)
    throw new BridgeError(`cannot parse expect ${JSON.stringify(x)} – use "PROGRAM/DYNPRO", e.g. "SAPLSE16N/120"`);
  return r;
}

