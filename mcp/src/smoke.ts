// MCP-level test: spawn the server over stdio, list tools, call one tool.
//   node dist/smoke.js                      -> sap_status
//   node dist/smoke.js sap_screen '{}'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const [tool = "sap_status", args = "{}"] = process.argv.slice(2);

const client = new Client({ name: "sapgui-java-smoke", version: "0.0.1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(here, "index.js")], env: process.env as Record<string, string> }));
const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map(t => t.name).join(", ")}`);
const r: any = await client.callTool({ name: tool, arguments: JSON.parse(args) });
console.log(`--- ${tool}${r.isError ? " (isError)" : ""}`);
for (const c of r.content) console.log(c.text);
await client.close();
