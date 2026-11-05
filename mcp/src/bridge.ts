// HTTP client for the in-GUI bridges (scripts/bridge.js) – one bridge per SAP GUI JVM.
//
// Every bridge registers itself in ~/.sapgui-java-mcp/bridges/<pid>.json (port, token, version);
// bridge.json holds the most recently started one (kept for scripts/sgb and older bridges).
// Sessions are addressed by a reference that names the JVM:
//   "<pid>/con[0]/ses[1]"   always unambiguous
//   "con[0]/ses[1]"         accepted only while a single bridge is running
import { readFile, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const BRIDGE_DIR = process.env.SAPGUI_BRIDGE_DIR ?? join(homedir(), ".sapgui-java-mcp");
const INFO_FILE = join(BRIDGE_DIR, "bridge.json");
const REG_DIR = join(BRIDGE_DIR, "bridges");
const CONFIG_FILE = join(BRIDGE_DIR, "config.json");
const TIMEOUT_MS = Number(process.env.SAPGUI_BRIDGE_TIMEOUT_MS ?? 60000);

export class BridgeError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

const NOT_RUNNING =
  "SAP GUI bridge is not running. Start SAP GUI with the bridge (launcher \"SAP GUI (MCP bridge)\" or sap-logon), " +
  "or run scripts/bridge.js from the Scripting menu.";

export interface BridgeInfo { port: number; token: string; version?: string; started?: string; pid: number }

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };

/** All running bridges, newest first. Registration files of dead JVMs are removed. */
export async function listBridges(): Promise<BridgeInfo[]> {
  const found = new Map<number, BridgeInfo>();
  try {
    for (const f of await readdir(REG_DIR)) {
      if (!/^\d+\.json$/.test(f)) continue;
      const path = join(REG_DIR, f);
      try {
        const b = JSON.parse(await readFile(path, "utf8")) as BridgeInfo;
        if (!b.port || !b.token || !b.pid) continue;
        if (alive(b.pid)) found.set(b.pid, b); else await unlink(path).catch(() => undefined);
      } catch { /* being rewritten */ }
    }
  } catch { /* no registry yet */ }
  // bridges older than 0.9 only write bridge.json
  try {
    const b = JSON.parse(await readFile(INFO_FILE, "utf8")) as BridgeInfo;
    if (b.port && b.token && b.pid && alive(b.pid) && !found.has(b.pid)) found.set(b.pid, b);
  } catch { /* none */ }
  return [...found.values()].sort((a, b) => String(b.started ?? "").localeCompare(String(a.started ?? "")));
}

/** The most recently started bridge – for callers that need exactly one. */
export async function readInfo(): Promise<BridgeInfo> {
  const all = await listBridges();
  if (!all.length) throw new BridgeError(NOT_RUNNING);
  return all[0];
}

export interface McpConfig { deniedTransactions: string[]; ownSession: boolean; defaultSystem?: string }

export async function readConfig(): Promise<McpConfig> {
  try {
    const c = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    return {
      deniedTransactions: (c.deniedTransactions ?? []).map((t: string) => String(t).toUpperCase()),
      ownSession: c.ownSession !== false,
      defaultSystem: typeof c.defaultSystem === "string" ? c.defaultSystem.toUpperCase() : undefined,
    };
  } catch {
    return { deniedTransactions: [], ownSession: true };
  }
}

// ---------------------------------------------------------------- session references
const relId = (id: string) => String(id).replace(/^\/app\//, "");
export function makeRef(pid: number, id: string, bridgeCount: number): string {
  return bridgeCount > 1 ? `${pid}/${relId(id)}` : relId(id);
}
/** "<pid>/con[0]/ses[1]" → {pid, session}; "con[0]/ses[1]" → {session} */
export function parseRef(ref: string): { pid?: number; session: string } {
  const r = ref.trim().replace(/^\/app\//, "");
  const m = /^(\d+)\/(con\[\d+\]\/ses\[\d+\].*)$/.exec(r);
  return m ? { pid: Number(m[1]), session: m[2] } : { session: r };
}

// Endpoints that act on a session. Without an explicit "session" they go to the agent's own session
// of the requested system (see session.ts) – never silently to a session the user is working in.
const SESSION_ENDPOINTS = new Set(["screen", "set", "press", "vkey", "tcode", "command", "grid", "table", "tree",
  "grid_action", "tree_action", "screenshot", "list", "text", "text_set", "session_open", "session_close"]);
let sessionResolver: ((system?: string) => Promise<string | undefined>) | undefined;
export function setSessionResolver(fn: (system?: string) => Promise<string | undefined>) { sessionResolver = fn; }

/** Low level: one request to one bridge. */
export async function callBridge<T = any>(b: BridgeInfo, endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${b.port}/${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${b.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError")
      throw new BridgeError(`bridge ${b.pid} did not answer within ${TIMEOUT_MS / 1000}s – SAP GUI may be blocked by a dialog or a long-running request`);
    throw new BridgeError(NOT_RUNNING + ` (connection to bridge ${b.pid} on 127.0.0.1:${b.port} failed: ${e?.cause?.code ?? e?.message})`);
  }
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { throw new BridgeError(`bridge returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status); }
  if (res.status === 401) throw new BridgeError(`bridge ${b.pid} rejected the token – its registration is stale; restart that SAP GUI or reload the bridge`, 401);
  if (!res.ok) throw new BridgeError(data?.error ?? `HTTP ${res.status}`, res.status);
  return data as T;
}

/** Attach the session reference to every session object in a bridge response. */
function tagRefs(data: any, pid: number, count: number) {
  const tag = (s: any) => { if (s && typeof s.id === "string") s.ref = makeRef(pid, s.id, count); };
  if (!data || typeof data !== "object") return;
  tag(data.session); tag(data.info); tag(data.screen?.session);
  if (typeof data.session === "string" && /ses\[\d+\]/.test(data.session)) data.sessionRef = makeRef(pid, data.session, count);
  if (typeof data.closed === "string") data.closedRef = makeRef(pid, data.closed, count);
}

/**
 * Route a request: an explicit session reference picks its bridge; without one the resolver supplies the
 * agent session of body.system. Endpoints without a session (status, reload, stop) go to the newest bridge.
 */
export async function call<T = any>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
  const bridges = await listBridges();
  if (!bridges.length) throw new BridgeError(NOT_RUNNING);
  const { system, ...rest } = body as { system?: string } & Record<string, unknown>;
  let payload: Record<string, unknown> = rest;
  let target = bridges[0];
  if (SESSION_ENDPOINTS.has(endpoint)) {
    let ref = typeof rest.session === "string" && rest.session !== "" ? rest.session : undefined;
    if (!ref && sessionResolver && endpoint !== "session_open") ref = await sessionResolver(system);
    if (ref) {
      const p = parseRef(ref);
      if (p.pid !== undefined) {
        const b = bridges.find(x => x.pid === p.pid);
        if (!b) throw new BridgeError(`no running bridge with pid ${p.pid} (session ${ref}) – see sap_status`);
        target = b;
      } else if (bridges.length > 1) {
        throw new BridgeError(`session "${ref}" is ambiguous: ${bridges.length} SAP GUI processes are running – ` +
          `use the reference from sap_status, e.g. "${bridges[0].pid}/${p.session}", or pass system`);
      }
      payload = { ...rest, session: p.session };
    }
  }
  const data = await callBridge<T>(target, endpoint, payload);
  tagRefs(data, target.pid, bridges.length);
  return data;
}

/** Every bridge's /status, with session refs attached. Bridges that do not answer are reported, not fatal. */
export async function statusAll(): Promise<{ bridge: BridgeInfo; status?: any; error?: string }[]> {
  const bridges = await listBridges();
  return Promise.all(bridges.map(async b => {
    try {
      const s = await callBridge(b, "status");
      for (const c of s.connections ?? []) for (const x of c.sessions ?? []) if (x.id) x.ref = makeRef(b.pid, x.id, bridges.length);
      return { bridge: b, status: s };
    } catch (e: any) { return { bridge: b, error: e?.message ?? String(e) }; }
  }));
}

export interface SessionRow {
  ref: string; pid: number; id: string; system: string; client: string; user: string; language: string;
  transaction: string; program: string; screen: number; agent?: boolean; readOnly?: boolean;
}
/** All readable sessions of all bridges. */
export async function allSessions(): Promise<SessionRow[]> {
  const rows: SessionRow[] = [];
  for (const r of await statusAll()) {
    if (!r.status) continue;
    for (const c of r.status.connections ?? []) for (const x of c.sessions ?? [])
      if (!x.error) rows.push({ ...x, pid: r.bridge.pid });
  }
  return rows;
}
