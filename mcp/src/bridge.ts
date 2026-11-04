// HTTP client for the in-GUI bridge (scripts/bridge.js)
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const BRIDGE_DIR = process.env.SAPGUI_BRIDGE_DIR ?? join(homedir(), ".sapgui-java-mcp");
const INFO_FILE = join(BRIDGE_DIR, "bridge.json");
const CONFIG_FILE = join(BRIDGE_DIR, "config.json");
const TIMEOUT_MS = Number(process.env.SAPGUI_BRIDGE_TIMEOUT_MS ?? 60000);

export class BridgeError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

const NOT_RUNNING =
  "SAP GUI bridge is not running. In SAP GUI for Java: log on, then run scripts/bridge.js " +
  "from the Scripting menu (once per GUI start).";

interface BridgeInfo { port: number; token: string; version?: string; started?: string }

export async function readInfo(): Promise<BridgeInfo> {
  try {
    const info = JSON.parse(await readFile(INFO_FILE, "utf8")) as BridgeInfo;
    if (!info.port || !info.token) throw new Error("incomplete");
    return info;
  } catch {
    throw new BridgeError(NOT_RUNNING);
  }
}

export interface McpConfig { deniedTransactions: string[] }

export async function readConfig(): Promise<McpConfig> {
  try {
    const c = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
    return { deniedTransactions: (c.deniedTransactions ?? []).map((t: string) => String(t).toUpperCase()) };
  } catch {
    return { deniedTransactions: [] };
  }
}

export async function call<T = any>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
  // bridge.json is re-read on every call: port and token change when the bridge restarts
  const info = await readInfo();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${info.port}/${endpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError")
      throw new BridgeError(`bridge did not answer within ${TIMEOUT_MS / 1000}s – SAP GUI may be blocked by a dialog or a long-running request`);
    throw new BridgeError(NOT_RUNNING + ` (connection to 127.0.0.1:${info.port} failed: ${e?.cause?.code ?? e?.message})`);
  }
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { throw new BridgeError(`bridge returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status); }
  if (res.status === 401) throw new BridgeError("bridge rejected the token – bridge.json is stale; restart scripts/bridge.js in SAP GUI", 401);
  if (!res.ok) throw new BridgeError(data?.error ?? `HTTP ${res.status}`, res.status);
  return data as T;
}
