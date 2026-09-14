#!/usr/bin/env -S npx tsx
/**
 * Live smoke for mcp-scryfall. Scryfall needs no API key; this needs network.
 *
 * Phase 1 drives the server the way a real MCP client does: spawn index.ts as
 * a child process and speak newline-delimited JSON-RPC over its stdio. An
 * in-process transport exercises the handlers but not the process — a missing
 * tsx, an import that only breaks under the real entry point, or a server that
 * dies before the handshake all pass in-process and fail here, and it is here
 * that a client would hit them.
 *
 * Phase 2 scans the source for two invariants cheaper to assert than to
 * re-derive: every request goes through the one rate-limited fetch site, and
 * no contact address is hardcoded (that belongs in SCRYFALL_CONTACT).
 *
 * Phase 3 checks the upstream endpoints directly, so an upstream change is
 * distinguishable from a bug in this server.
 *
 * Run: npm run smoke.  Exit 0 = all passed, 1 = any failed.
 * SMOKE_SERVER_PATH overrides the entry point served in phase 1 — a copy must
 * live in this directory so its SDK imports still resolve.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = process.env.SMOKE_SERVER_PATH?.trim() || join(HERE, "index.ts");
const TSX_CLI = join(HERE, "node_modules", "tsx", "dist", "cli.mjs");
const TIMEOUT_MS = 30_000;

const EXPECTED_TOOLS = [
  "card_named",
  "card_fuzzy",
  "card_search",
  "card_collection",
  "card_random",
  "card_rulings",
  "bulk_default",
];

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

/* ------------------------------------------------- stdio JSON-RPC harness */

class StdioSession {
  child: ChildProcess;
  private pending = new Map<number, (msg: any) => void>();
  private nextId = 1;
  stderr = "";

  constructor(serverPath: string) {
    // Spawn through the bundled tsx cli, the way an MCP client config does. A
    // missing cli.mjs (npm install never ran) is itself a real-channel failure.
    this.child = spawn("node", [TSX_CLI, serverPath], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr!.on("data", (d) => { this.stderr += String(d); });
    let buf = "";
    this.child.stdout!.on("data", (d) => {
      buf += String(d);
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            this.pending.get(msg.id)!(msg);
            this.pending.delete(msg.id);
          }
        } catch { /* non-JSON stdout line — ignore */ }
      }
    });
  }

  rpc(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), TIMEOUT_MS);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result);
      });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  kill(): void { this.child.kill(); }
}

/** Tool results arrive as a content array of text parts holding JSON. */
function payload(result: any): any {
  return JSON.parse(result?.content?.[0]?.text ?? "{}");
}

/* ------------------------------------------- phase 1: stdio (real channel) */

check("tsx cli.mjs present (npm install ran)", existsSync(TSX_CLI), TSX_CLI);

const session = new StdioSession(SERVER_PATH);
try {
  const init = await session.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcp-scryfall-smoke", version: "1.0.0" },
  });
  check("stdio: initialize handshake", init?.serverInfo?.name === "mcp-scryfall",
    `serverInfo.name=${init?.serverInfo?.name}`);
  session.notify("notifications/initialized");

  const list = await session.rpc("tools/list");
  const names: string[] = (list?.tools ?? []).map((t: any) => t.name);
  check(`stdio: tools/list is exactly the ${EXPECTED_TOOLS.length} tools`,
    names.length === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((n) => names.includes(n)),
    names.join(", "));
  check("stdio: every tool declares an object inputSchema",
    (list?.tools ?? []).every((t: any) => t.inputSchema?.type === "object"));

  const card = payload(await session.rpc("tools/call",
    { name: "card_named", arguments: { name: "Black Lotus" } }));
  check("stdio: card_named round-trips a real card",
    card?.object === "card" && card?.name === "Black Lotus",
    `object=${card?.object} name=${card?.name}`);

  const search = payload(await session.rpc("tools/call",
    { name: "card_search", arguments: { q: "is:fetchland" } }));
  check("stdio: card_search summarizes with oracle_text",
    typeof search?.total_cards === "number" && Array.isArray(search?.data) &&
    search.data.length > 0 && typeof search.data[0].oracle_text === "string",
    `total_cards=${search?.total_cards}`);

  // The grounding probe: a name no card has must surface as an error, never as
  // a nearest match. A caller checking a deck list depends on exactly this.
  let fabricatedErrored = false;
  try {
    await session.rpc("tools/call",
      { name: "card_named", arguments: { name: "Xyzzy Fabricated Nonexistent Card 99999" } });
  } catch {
    fabricatedErrored = true;
  }
  check("stdio: a fabricated name errors (never a guessed card)", fabricatedErrored);

  const batch = payload(await session.rpc("tools/call", {
    name: "card_collection",
    arguments: { identifiers: ["Lightning Bolt", "Counterspell", "Xyzzy Fabricated Nonexistent Card 99999"] },
  }));
  check("stdio: card_collection resolves real names and reports the miss",
    batch?.requested === 3 && batch?.found === 2 &&
    Array.isArray(batch?.not_found) && batch.not_found.length === 1 &&
    (batch?.data ?? []).some((c: any) => c.name === "Lightning Bolt"),
    `requested=${batch?.requested} found=${batch?.found} not_found=${JSON.stringify(batch?.not_found)}`);
  check("stdio: summaries carry the grounding fields",
    (batch?.data ?? []).every((c: any) =>
      c.name && c.type_line && "oracle_text" in c && "power" in c &&
      "color_identity" in c && "legal_commander" in c),
    JSON.stringify(Object.keys(batch?.data?.[0] ?? {})));

  // Dryad Arbor, not Black Lotus: Black Lotus has zero rulings, so a shape-only
  // assertion over it passed whether the rulings path worked or always returned
  // empty. Assert a non-empty list with real comment text so this can fail.
  const rulings = payload(await session.rpc("tools/call",
    { name: "card_rulings", arguments: { name: "Dryad Arbor" } }));
  check("stdio: card_rulings returns a non-empty rulings list",
    rulings?.object === "list" && Array.isArray(rulings?.data) &&
    rulings.data.length > 0 && typeof rulings.data[0]?.comment === "string",
    `object=${rulings?.object} entries=${rulings?.data?.length}`);

  const random = payload(await session.rpc("tools/call", { name: "card_random", arguments: {} }));
  check("stdio: card_random returns a card",
    typeof random?.name === "string" && random.name.length > 0);

  const bulk = payload(await session.rpc("tools/call", { name: "bulk_default", arguments: {} }));
  const bulkItem = bulk?.data?.[0] ?? {};
  check("stdio: bulk_default lists download endpoints",
    Array.isArray(bulk?.data) && bulk.data.length > 0 &&
    typeof bulkItem.jsonl_download_uri === "string");

  // The description is what a model reads to decide how to use the tool, so an
  // upstream rename makes it actively misleading rather than merely stale — and
  // the mocked unit test cannot catch one, since it asserts its own fixture.
  // Scryfall moved to jsonl_download_uri/compressed_size (from download_uri/
  // size) by 2026-08-15. Every snake_case field the description names must
  // exist on a real payload item.
  const bulkDesc: string =
    (list?.tools ?? []).find((t: any) => t.name === "bulk_default")?.description ?? "";
  const namedFields = [...new Set(bulkDesc.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])];
  const missingFields = namedFields.filter((f) => !(f in bulkItem));
  check("stdio: every field bulk_default's description names exists on the payload",
    namedFields.length > 0 && missingFields.length === 0,
    `named=[${namedFields.join(", ")}] missing=[${missingFields.join(", ")}]`);
} catch (e) {
  check(`stdio harness error: ${(e as Error).message}`, false, session.stderr.slice(-400));
} finally {
  session.kill();
}

/* ------------------------------------------------- phase 2: source scans */

const src = readFileSync(join(HERE, "server.ts"), "utf8");

const fetchSites = (src.match(/\bfetch\(/g) ?? []).length;
check("scan: exactly one fetch site (so rate limit + UA cover every request)",
  fetchSites === 1, `${fetchSites} found`);

// An email-shaped literal would be a hardcoded contact. Import specifiers
// carry "/" in the local part and are excluded by construction.
const pii = src.match(/['"][^'"/\s]+@[^'"/\s]+\.[a-z]{2,}['"]/i);
check("scan: no hardcoded email literal (contact belongs in SCRYFALL_CONTACT)",
  !pii, pii ? pii[0] : "");

/* -------------------------------------------- phase 3: upstream contract */

const SCRYFALL = "https://api.scryfall.com";
const UA = "mcp-scryfall smoke test (https://github.com/haksanlulz/mcp-scryfall)";

/**
 * Each endpoint is asserted by a POSITIVE property of what it served, not merely
 * by the shape of a reply.
 *
 * The previous condition was `res.ok || json.object === "error"`, and Scryfall
 * returns {"object":"error"} for every failure it owns -- so a 404, a 410 or a
 * retired endpoint all reported PASS. The only reachable FAIL was a non-ok
 * response that was valid JSON and NOT object:"error", and a non-JSON body threw
 * out of res.json() at top level instead, skipping the summary and the failures
 * report entirely. The whole request is wrapped now, so an unreachable host or an
 * HTML error page records a FAIL rather than ending the run.
 */
async function upstream(
  label: string,
  path: string,
  ok: (json: any) => boolean,
): Promise<void> {
  try {
    const res = await fetch(`${SCRYFALL}${path}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    const raw = await res.text();
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      check(`upstream ${label}`, false,
        `status=${res.status} non-JSON body: ${raw.slice(0, 120)}`);
      return;
    }
    const name = json && typeof json === "object" && "name" in json ? ` name=${json.name}` : "";
    check(`upstream ${label}`, res.ok && ok(json),
      `status=${res.status} object=${json?.object}${name}`);
  } catch (e) {
    check(`upstream ${label}`, false, `request failed: ${(e as Error).message}`);
  } finally {
    await new Promise((r) => setTimeout(r, 120));
  }
}

await upstream("card_named", "/cards/named?exact=Black+Lotus",
  (j) => j.object === "card" && j.name === "Black Lotus");
await upstream("card_fuzzy", "/cards/named?fuzzy=lighming+bolt",
  (j) => j.object === "card" && j.name === "Lightning Bolt");
await upstream("card_search", "/cards/search?q=is%3Afetchland",
  (j) => j.object === "list" && Array.isArray(j.data) && j.data.length > 0);
await upstream("card_random", "/cards/random",
  (j) => j.object === "card" && typeof j.name === "string" && j.name.length > 0);
await upstream("bulk_default", "/bulk-data",
  (j) => j.object === "list" && j.data?.[0]?.object === "bulk_data");

console.log(failures.length ? `\n${failures.length} check(s) FAILED: ${failures.join(", ")}` : "\nAll checks passed.");
process.exit(failures.length ? 1 : 0);
