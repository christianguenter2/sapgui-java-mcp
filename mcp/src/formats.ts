// User input formats (date / decimal notation / time) from the user defaults (SU3, tab "Defaults").
// The Java GUI's GuiSessionInfo has getDateFormat()/getDecimalFormat(), but they stay empty, so the
// values are read from SU3 – in a separate session (/oSU3) that is closed again (/i); the user's
// session is not touched. Read-only: nothing is saved (and the write gate would refuse it).
import { call, BridgeError, allSessions, SessionRow } from "./bridge.js";

// USR01-DATFM / -DCPFM / -TIMEFM keys
const DATE: Record<string, string> = {
  "1": "DD.MM.YYYY", "2": "MM/DD/YYYY", "3": "MM-DD-YYYY", "4": "YYYY.MM.DD", "5": "YYYY/MM/DD",
  "6": "YYYY-MM-DD", "7": "GYY.MM.DD (Japanese)", "8": "GYY/MM/DD (Japanese)", "9": "GYY-MM-DD (Japanese)",
  A: "YYYY/MM/DD (Islamic)", B: "YYYY/MM/DD (Islamic)", C: "YYYY/MM/DD (Iranian)",
};
// the combo key of DCPFM blank comes back as "" (the scripting API trims it)
const DECIMAL: Record<string, string> = { "": "1.234.567,89", X: "1,234,567.89", Y: "1 234 567,89" };
const TIME: Record<string, string> = { "0": "24h (HH:MM:SS)", "1": "12h (HH:MM:SS AM/PM)", "2": "12h (HH:MM:SS am/pm)", "3": "0-11 (KK:MM:SS AM/PM)", "4": "0-11 (KK:MM:SS am/pm)" };

export interface UserFormats {
  user: string; date: string; decimal: string; time: string; timeZone: string; systemTimeZone: string;
  raw: { datfm: string; dcpfm: string; timefm: string };
}

const cache = new Map<string, UserFormats>();
export const cachedFormats = (key: string) => cache.get(key);

/** Formats of the user of a session (ref) or of a system ("SID/client"); default: the first session. */
export async function userFormats(session?: string, refresh = false, system?: string): Promise<UserFormats> {
  const all = await allSessions();
  const sys = system?.toUpperCase();
  const base = session ? all.find(x => x.ref === session || x.ref.endsWith("/" + session) || x.id.replace(/^\/app\//, "") === session)
    : sys ? all.find(x => `${x.system}/${x.client}`.toUpperCase() === sys && !x.agent) ?? all.find(x => `${x.system}/${x.client}`.toUpperCase() === sys)
    : all[0];
  if (!base) throw new BridgeError(session ? `session ${session} not found` : sys ? `system ${sys} is not logged on` : "no SAP GUI session");
  const key = `${base.system}/${base.client}/${base.user}`;
  if (!refresh && cache.has(key)) return cache.get(key)!;

  const before = new Set(all.map(x => x.ref));
  await call("command", { session: base.ref, command: "/oSU3", returnScreen: false });
  let su3: SessionRow | undefined;
  for (let i = 0; i < 25 && !su3; i++) {
    await new Promise(r => setTimeout(r, 200));
    su3 = (await allSessions()).find(x => !before.has(x.ref) && x.pid === base.pid && x.transaction === "SU3");
  }
  if (!su3) throw new BridgeError("could not open SU3 in a new session (/oSU3) – session limit reached?");
  const sid = su3.ref;
  try {
    const scr = await call("screen", { session: sid, maxNodes: 600 });
    const tab = scr.elements.find((e: any) => /\/tabpDEFA$/.test(e.id));
    if (!tab) throw new BridgeError("SU3: tab Defaults (tabpDEFA) not found");
    const r = await call("press", { session: sid, id: tab.id, maxNodes: 600, expect: { transaction: "SU3" } });
    const els: any[] = r.screen.elements;
    const val = (suffix: string, key = true) => {
      // the field, not its label (lbl…-DATFM ends the same way)
      const e = els.find(x => x.id.endsWith(suffix) && x.type !== "GuiLabel");
      if (!e) return undefined;
      return key && e.key !== undefined ? String(e.key).trim() : String(e.text ?? "").trim();
    };
    const datfm = val("-DATFM"), dcpfm = val("-DCPFM"), timefm = val("-TIMEFM");
    if (datfm === undefined || dcpfm === undefined)
      throw new BridgeError("SU3: fields DATFM/DCPFM not found on the Defaults tab");
    const f: UserFormats = {
      user: key,
      date: DATE[datfm] ?? `code ${datfm}`,
      decimal: DECIMAL[dcpfm] ?? `code ${JSON.stringify(dcpfm)}`,
      time: timefm === undefined ? "" : (TIME[timefm] ?? `code ${timefm}`),
      timeZone: val("-TZONE_IANA", false) || val("-TZONE", false) || "",
      systemTimeZone: val("-TZONESYS", false) ?? "",
      raw: { datfm, dcpfm, timefm: timefm ?? "" },
    };
    cache.set(key, f);
    return f;
  } finally {
    // close the extra session again (never the user's one)
    await call("command", { session: sid, command: "/i", returnScreen: false }).catch(() => undefined);
  }
}
