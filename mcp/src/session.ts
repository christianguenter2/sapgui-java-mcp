// The agent's own SAP GUI sessions – one per system. The user and the agent must not share a session:
// the user navigating in it broke the agent's flow three times (the screen guard caught it each time).
//
// With config ownSession (default true) every tool call without an explicit session goes to the agent
// session of the requested system ("SID/client", tool parameter `system`). It is opened next to a user
// session of that system – so in the right SAP GUI JVM when several are running – on first use, reopened
// if it was closed, and adopted from the bridge after an MCP restart. Which system when none is given:
// the only one logged on, else config defaultSystem, else the one used last.
// Passing session explicitly (e.g. "con[0]/ses[0]") is the user handing a session over.
import { call, readConfig, setSessionResolver, setSessionForget, allSessions, SessionRow, BridgeError } from "./bridge.js";

const agents = new Map<string, string>();    // "SID/CLIENT" → session ref
const checkedAt = new Map<string, number>();
let lastSystem: string | undefined;
const RECHECK_MS = 10_000;

const sysKey = (r: { system: string; client: string }) => `${r.system}/${r.client}`.toUpperCase();
export function agentSession(system?: string): string | undefined {
  return agents.get((system ?? lastSystem ?? "").toUpperCase());
}
export function agentSessions(): Map<string, string> { return agents; }

/** Decide which system a call without explicit session is meant for. */
async function pickSystem(all: SessionRow[], system?: string): Promise<string> {
  const systems = [...new Set(all.map(sysKey))];
  if (system) {
    const s = system.toUpperCase();
    if (!systems.includes(s)) throw new BridgeError(`system ${s} is not logged on in any SAP GUI with a bridge – logged on: ${systems.join(", ") || "none"}`);
    return s;
  }
  if (systems.length === 1) return systems[0];
  const cfg = await readConfig();
  if (cfg.defaultSystem && systems.includes(cfg.defaultSystem)) return cfg.defaultSystem;
  if (lastSystem && systems.includes(lastSystem)) return lastSystem;
  if (!systems.length) throw new BridgeError("no SAP GUI session found – log on in SAP GUI (started with the bridge) first");
  throw new BridgeError(`several systems are logged on (${systems.join(", ")}) – pass system, e.g. "${systems[0]}", ` +
    `or set "defaultSystem" in ~/.sapgui-java-mcp/config.json`);
}

/** Open a new agent session for a system (always a new one) and make it that system's default. */
export async function openAgentSession(system?: string, base?: string): Promise<{ session: string; system: string; info: any }> {
  const all = await allSessions();
  const sys = await pickSystem(all, system);
  let baseRef = base;
  if (!baseRef) {
    // next to a user session of that system – that pins the JVM and the connection
    const user = all.find(x => sysKey(x) === sys && !x.agent) ?? all.find(x => sysKey(x) === sys);
    if (!user) throw new BridgeError(`no session of ${sys} to open an agent session next to`);
    baseRef = user.ref;
  }
  const r = await call("session_open", { session: baseRef });
  const ref = r.sessionRef ?? r.session;
  agents.set(sys, ref); checkedAt.set(sys, Date.now()); lastSystem = sys;
  return { session: ref, system: sys, info: r.info };
}

/** The agent session to use for a system; opens one if none exists (or it was closed). */
export async function ensureAgentSession(system?: string): Promise<string> {
  const known = system ? agents.get(system.toUpperCase()) : undefined;
  if (known && Date.now() - (checkedAt.get(system!.toUpperCase()) ?? 0) < RECHECK_MS) { lastSystem = system!.toUpperCase(); return known; }
  const all = await allSessions();
  const sys = await pickSystem(all, system);
  lastSystem = sys;
  const mine = agents.get(sys);
  if (mine && all.some(x => x.ref === mine)) { checkedAt.set(sys, Date.now()); return mine; }
  // adopt an agent session the bridge already knows (e.g. after an MCP restart)
  const adopted = all.find(x => x.agent && sysKey(x) === sys);
  if (adopted) { agents.set(sys, adopted.ref); checkedAt.set(sys, Date.now()); return adopted.ref; }
  return (await openAgentSession(sys)).session;
}

export async function closeAgentSession(session?: string, system?: string): Promise<string> {
  const target = session ?? agents.get((system ?? lastSystem ?? "").toUpperCase());
  if (!target) throw new BridgeError("no agent session open" + (system ? ` for ${system}` : ""));
  const r = await call("session_close", { session: target });
  for (const [k, v] of agents) if (v === target) { agents.delete(k); checkedAt.delete(k); }
  return r.closedRef ?? r.closed;
}

setSessionForget(ref => { for (const [k, v] of agents) if (v === ref) { agents.delete(k); checkedAt.delete(k); } });
setSessionResolver(async (system?: string) => ((await readConfig()).ownSession ? ensureAgentSession(system) : undefined));
