// The agent's own SAP GUI session. The user and the agent must not share a session: the user
// navigating in it broke the agent's flow three times (the screen guard caught it each time).
// With config ownSession (default true) every tool call without an explicit session goes to a session
// the bridge opened for the agent (createSession); it is opened on first use and reopened if it was
// closed. Passing session explicitly (e.g. "con[0]/ses[0]") is the user handing a session over.
import { call, readConfig, setSessionResolver } from "./bridge.js";

let agent: string | undefined;
let checkedAt = 0;
const RECHECK_MS = 10_000;

type Ses = { id: string; agent?: boolean };
async function sessions(): Promise<Ses[]> {
  const s = await call("status");
  return s.connections.flatMap((c: any) => c.sessions.filter((x: any) => !x.error));
}
const rel = (id: string) => id.replace(/^\/app\//, "");

export function agentSession(): string | undefined { return agent; }

/** Open a new agent session (always a new one) and make it the default. */
export async function openAgentSession(base?: string): Promise<{ session: string; info: any }> {
  const r = await call("session_open", base ? { session: base } : {});
  agent = r.session;
  checkedAt = Date.now();
  return { session: r.session, info: r.info };
}

/** The agent session to use; opens one if none exists (or it was closed). */
export async function ensureAgentSession(): Promise<string> {
  if (agent && Date.now() - checkedAt < RECHECK_MS) return agent;
  const all = await sessions();
  if (agent && all.some(x => rel(x.id) === agent)) { checkedAt = Date.now(); return agent; }
  // adopt an agent session the bridge already knows (e.g. after an MCP restart)
  const known = all.find(x => x.agent);
  if (known) { agent = rel(known.id); checkedAt = Date.now(); return agent; }
  return (await openAgentSession()).session;
}

export async function closeAgentSession(session?: string): Promise<string> {
  const target = session ?? agent;
  if (!target) throw new Error("no agent session open");
  const r = await call("session_close", { session: target });
  if (target === agent) { agent = undefined; checkedAt = 0; }
  return r.closed;
}

setSessionResolver(async () => ((await readConfig()).ownSession ? ensureAgentSession() : undefined));
