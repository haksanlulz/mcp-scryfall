#!/usr/bin/env -S npx tsx
// hits the live scryfall api directly (not via mcp stdio); needs network
const SCRYFALL = "https://api.scryfall.com";
const UA = "mcp-scryfall/1.0 smoke-test (https://github.com/haksanlulz/mcp-scryfall)";

// expectOk=true means the call must return a real hit; only the error-probe passes on object:"error"
async function check(label: string, path: string, expectOk = true): Promise<void> {
  const res = await fetch(`${SCRYFALL}${path}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  const text = await res.text();
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    console.error(`FAIL ${label}: non-JSON status=${res.status} body=${text.slice(0, 200)}`);
    process.exit(1);
  }
  const ok = expectOk ? res.ok : json.object === "error";
  if (ok) {
    console.log(`PASS ${label}: status=${res.status} object=${json.object} ${'name' in json ? `name=${json.name}` : ''}`);
  } else {
    console.error(`FAIL ${label}: status=${res.status} body=${JSON.stringify(json).slice(0, 200)}`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 120));
}

await check("card_named (Muldrotha)", "/cards/named?exact=Muldrotha%2C+the+Gravetide");
await check("card_fuzzy (heartmender)", "/cards/named?fuzzy=heartmender");
await check("card_search (is:fetchland)", "/cards/search?q=is%3Afetchland");
await check("card_random", "/cards/random");
await check("bulk_default", "/bulk-data");
// error-path probe: a bogus exact name must return object:"error", not a hit
await check("error-shape (bogus name)", "/cards/named?exact=zzznotacardzzz", false);
console.log("=== all smoke PASS ===");
