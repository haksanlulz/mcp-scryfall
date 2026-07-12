#!/usr/bin/env -S npx tsx
// Live smoke: one real call per tool, driven in-process over MCP (InMemoryTransport)
// so it exercises THIS server, not the Scryfall API directly. Scryfall needs no key;
// needs network.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

const server = createServer();
const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(st), client.connect(ct)]);

let failed = 0;
async function check(name: string, args: Record<string, unknown>, ok: (b: any) => boolean) {
  try {
    const res: any = await client.callTool({ name, arguments: args });
    const body = JSON.parse(res.content[0].text);
    if (ok(body)) console.log(`ok   ${name}`);
    else { failed++; console.error(`FAIL ${name}: unexpected shape\n${JSON.stringify(body).slice(0, 300)}`); }
  } catch (e: any) {
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
  }
}

await check("card_named", { name: "Black Lotus" }, (b) => b.name === "Black Lotus");
await check("card_fuzzy", { name: "jace belren" }, (b) => typeof b.name === "string" && /jace/i.test(b.name));
await check("card_search", { q: "is:fetchland" }, (b) => typeof b.total_cards === "number" && Array.isArray(b.data) && b.data.length > 0 && typeof b.data[0].oracle_text === "string");
await check(
  "card_collection",
  { identifiers: ["Lightning Bolt", "Counterspell", "Zzzz Definitely Not A Card"] },
  (b) =>
    b.requested === 3 &&
    b.found === 2 &&
    Array.isArray(b.not_found) &&
    b.not_found.length === 1 &&
    b.data.every((c: any) => typeof c.oracle_text === "string" && c.oracle_text.length > 0),
);
await check("card_random", {}, (b) => typeof b.name === "string" && b.name.length > 0);
await check("bulk_default", {}, (b) => Array.isArray(b.data) && b.data.length > 0 && typeof b.data[0].download_uri === "string");

console.log(failed === 0 ? "smoke: all passed" : `smoke: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
