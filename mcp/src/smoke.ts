// MCP-level test: spawn the server over stdio, list tools, call one or more tools in ONE session
// (so state such as the last screen for view=changed is kept between calls).
//   node dist/smoke.js                                  -> sap_status
//   node dist/smoke.js sap_screen '{}'
//   node dist/smoke.js sap_screen '{}' sap_send_key '{"key":"Enter"}'
// Env SMOKE_QUIET=1: print only the size (chars, lines) of each result.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const calls: [string, string][] = [];
if (argv.length === 0) calls.push(["sap_status", "{}"]);
for (let i = 0; i < argv.length; i += 2) calls.push([argv[i], argv[i + 1] ?? "{}"]);

const client = new Client({ name: "sapgui-java-smoke", version: "0.0.2" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, "index.js")], env: process.env as Record<string, string> }));
const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map(t => t.name).join(", ")}`);
for (const [tool, args] of calls) {
  const r: any = await client.callTool({ name: tool, arguments: JSON.parse(args) });
  const out = r.content.map((c: any) => c.text).join("\n");
  console.log(`--- ${tool} ${args}${r.isError ? " (isError)" : ""}` + (process.env.SMOKE_QUIET ? `: ${out.length} chars, ${out.split("\n").length} lines` : ""));
  if (!process.env.SMOKE_QUIET) console.log(out);
}
await client.close();
