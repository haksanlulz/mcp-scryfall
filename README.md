# mcp-scryfall

MCP server for live **Magic: The Gathering** card lookup via the [Scryfall API](https://scryfall.com/docs/api). Built on the [MCP TypeScript SDK](https://modelcontextprotocol.io).

LLMs misremember card names, costs, and rules text. This looks them up on live Scryfall instead. I use it daily for deckbuilding.

## Tools

| Tool | What it does |
|------|--------------|
| `card_named` | Exact-name lookup (optional set code). Full card object. |
| `card_fuzzy` | Fuzzy-name lookup. Handles typos and partial names. |
| `card_search` | [Scryfall query-syntax](https://scryfall.com/docs/syntax) search. Returns compact summaries by default (pass `full: true` for raw objects). A query matching no cards is an error, not an empty list — Scryfall answers a zero-result search with a 404. |
| `card_collection` | Batch lookup (`POST /cards/collection`) — resolve a whole decklist in one call. Takes exact-name strings and/or `{name}` / `{id}` / `{name, set}` / `{set, collector_number}` identifiers; misses come back in `not_found`. |
| `card_random` | A random card, optionally filtered by a query. |
| `card_rulings` | Official Wizards rulings for one card, by exact name or Scryfall id — the errata and corner-case answers that are not in the oracle text. |
| `bulk_default` | Lists Scryfall bulk-data endpoints for offline corpus building. |

The compact summary returned by `card_search` and `card_collection` is `name`, `mana_cost`, `type_line`, `cmc`, `set`, `collector_number`, `oracle_text`, `power`, `toughness`, `color_identity`, `legal_commander`. Every key is always present, `null` when the card has no value — so "this creature has no power" is distinguishable from "that field wasn't returned".

## Install

```bash
git clone https://github.com/haksanlulz/mcp-scryfall
cd mcp-scryfall
npm install
```

Runs directly with [`tsx`](https://github.com/privatenumber/tsx); no build step.

## Use it from an MCP client

Add it to your client's MCP config:

```json
{
  "mcpServers": {
    "scryfall": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-scryfall/index.ts"],
      "env": { "SCRYFALL_CONTACT": "you@example.com" }
    }
  }
}
```

## Configuration

All four knobs are environment variables, all optional. None is a credential — Scryfall's API needs no key.

| Variable | Default | Effect |
|---|---|---|
| `SCRYFALL_CONTACT` | this repository's URL | Added to the `User-Agent`, per Scryfall's API guidelines, so they can reach you about traffic. |
| `SCRYFALL_CACHE_TTL_MS` | `86400000` (24 h) | Lifetime of a cached GET response. `0` turns the cache off. |
| `SCRYFALL_CACHE_MAX` | `500` | LRU entry cap for that cache. Floor 1. |
| `SCRYFALL_MAX_ATTEMPTS` | `3` | Attempts per request, counting the first. Floor 1, ceiling 10. |

The three numeric ones are parsed once at load. A value that is not an integer, or outside its range, is rejected with a line on stderr and the default is used. That is not decoration: an unparseable value used to pass straight into the arithmetic, where a NaN TTL silently disabled the cache, a NaN cap silently removed the LRU bound, and a NaN or zero attempt cap issued no request at all.

`SCRYFALL_MAX_ATTEMPTS` is the only one with a ceiling, because it is the only one whose too-large direction is the dangerous one: retries wait inside the same serialized queue, and each wait can be a honoured `Retry-After` of up to 10 s, so a mistyped `3000` holds every later tool call in the process behind one failing request. It is rejected rather than clamped — a value that is bad only in magnitude gets the same notice as one that is bad in form.

## Install as a bundle (.mcpb)

```bash
npm install
npm run bundle
```

Writes `build/mcp-scryfall-<version>.mcpb`, then unpacks it and drives the packed entry point over stdio. Open the `.mcpb` with an MCPB host to install. The install dialog offers one optional field, **Contact**, which the manifest maps to `SCRYFALL_CONTACT`; leave it blank and the `User-Agent` falls back to this repository's URL. There is no API key — Scryfall needs none.

Sizes as of 2026-09-14: 3.2 MB packed, 10.5 MB unpacked, 2,268 files, nearly all of it the MCP SDK's dependency tree. The staging install is `npm ci --omit=dev` off this repo's lockfile, so tsx, vitest and typescript are not in it.

The bundle is the only place this repo emits JavaScript. Everything else runs `.ts` through tsx, but an MCPB host runs `node <entry_point>` with no toolchain of its own, so `manifest.json` (MCPB manifest version 0.3) points at `dist/index.js` built by `tsconfig.build.json`. Two shipping paths for one server is a drift risk, so `npm run bundle` does not stop at packing — it unpacks what it just wrote and asserts the handshake and all seven tools against it, offline. It also removes `dist/` before building, because `tsc` does not: staging copies the whole directory, so anything a bare `npx tsc` or a since-renamed file left there would otherwise pack silently. For a live round-trip through the built entry point rather than the source:

```bash
SMOKE_SERVER_PATH=/abs/path/to/mcp-scryfall/dist/index.js npm run smoke
```

`test/bundle-manifest.test.ts` pins the manifest against the code in the offline gate: `entry_point` and `args` naming the same file, `SCRYFALL_CONTACT` wired to a declared optional non-sensitive field, a privacy policy present (the bundle reaches Scryfall), and the manifest's tool list equal to what `tools/list` serves. What it cannot check is whether a host's install dialog really maps that field into the environment — that is host behavior, and only a real install exercises it.

Built and probed on Node 20 and 22 (the CI matrix), which is why `compatibility.runtimes.node` says `>=20`. `package.json`'s `engines` still says `>=18`; nothing here has been run on 18.

## Examples

Shapes below are exact. The volatile values — `total_cards`, and the `set` and `collector_number` of whatever the latest printing was — are what Scryfall returned on 2026-09-14; card text and P/T are the card's, not a sample of one.

`card_search` with `q = "c:rb cmc<=2 t:creature o:haste"` returns compact rows — rules text included — plus paging metadata. One of the 12 rows:

```json
{
  "total_cards": 12,
  "has_more": false,
  "page": 1,
  "data": [
    {
      "name": "Dreadhorde Butcher",
      "mana_cost": "{B}{R}",
      "type_line": "Creature — Zombie Warrior",
      "cmc": 2,
      "set": "war",
      "collector_number": "194",
      "oracle_text": "Haste\nWhenever this creature deals combat damage to a player or planeswalker, put a +1/+1 counter on this creature.\nWhen this creature dies, it deals damage equal to its power to any target.",
      "power": "1",
      "toughness": "1",
      "color_identity": ["B", "R"],
      "legal_commander": "legal"
    }
  ]
}
```

`card_collection` with `identifiers = ["Lightning Bolt", "Counterspell", "Zzzz Definitely Not A Card"]` resolves the whole list in one call and leads with what it couldn't find:

```json
{
  "requested": 3,
  "found": 2,
  "not_found": [{ "name": "Zzzz Definitely Not A Card" }],
  "data": [
    { "name": "Lightning Bolt", "mana_cost": "{R}", "type_line": "Instant", "cmc": 1, "set": "msc", "collector_number": "806", "oracle_text": "Lightning Bolt deals 3 damage to any target.", "power": null, "toughness": null, "color_identity": ["R"], "legal_commander": "legal" },
    { "name": "Counterspell", "mana_cost": "{U}{U}", "type_line": "Instant", "cmc": 2, "set": "dsc", "collector_number": "114", "oracle_text": "Counter target spell.", "power": null, "toughness": null, "color_identity": ["U"], "legal_commander": "legal" }
  ]
}
```

Scryfall caps one collection POST at 75 identifiers; longer lists are split into sequential rate-limited POSTs automatically, so a 100-card decklist is one tool call (two requests under the hood).

Pass `full: true` to either tool to get the raw Scryfall objects instead.

### The loop this exists for

Checking a decklist is the whole point: a model writing one produces names that are *nearly* right, and a near-miss is the failure mode that reads as success. `card_collection` is the batch form of that check — every name either comes back with its canonical spelling or appears in `not_found`, and nothing passes silently.

Run live 2026-09-14, five identifiers, one request. The `set` and `collector_number` values are whatever the latest printing was that day; the rest is exact:

```json
{
  "requested": 5,
  "found": 3,
  "not_found": [
    { "name": "Sylvan Libary" },
    { "name": "Teferi, Hero of Dominara" }
  ],
  "data": [
    { "name": "Sol Ring", "mana_cost": "{1}", "type_line": "Artifact", "cmc": 1, "set": "msc", "collector_number": "211", "oracle_text": "{T}: Add {C}{C}.", "power": null, "toughness": null, "color_identity": [], "legal_commander": "legal" },
    { "name": "Arcane Signet", "mana_cost": "{2}", "type_line": "Artifact", "cmc": 2, "set": "msc", "collector_number": "191", "oracle_text": "{T}: Add one mana of any color in your commander's color identity.", "power": null, "toughness": null, "color_identity": [], "legal_commander": "legal" },
    { "name": "Cyclonic Rift", "mana_cost": "{1}{U}", "type_line": "Instant", "cmc": 2, "set": "rvr", "collector_number": "40", "oracle_text": "Return target nonland permanent you don't control to its owner's hand.\nOverload {6}{U} (You may cast this spell for its overload cost. If you do, change \"target\" in its text to \"each.\")", "power": null, "toughness": null, "color_identity": ["U"], "legal_commander": "legal" }
  ]
}
```

Two of the five were wrong, and both are the shape that gets past a reader: `Sylvan Libary` is a dropped letter, and `Teferi, Hero of Dominara` is a subtitle recalled one letter off from `Dominaria`. Neither resolves — exact-name matching does not guess — so the builder's next move is to fix those two names and re-run, not to write them into a deck list. `legal_commander` on the three that did resolve answers the other half in the same response.

If a name is wrong in a way you cannot see, `card_fuzzy` one identifier at a time will find the intended card; `card_collection` will not, deliberately.

## Testing

```bash
npm test         # offline: vitest over an in-memory MCP transport, fetch mocked, no network
npm run typecheck
npm run bundle   # offline: packs the .mcpb, then drives the PACKED artifact over stdio
npm run smoke    # live: spawns the real server over stdio and calls Scryfall once per tool
```

Tiers split by script rather than by marker. `npm test`, `npm run typecheck` and `npm run bundle` are the gate and all run in CI; `npm run smoke` is a manual check against the live API and costs about 13 requests, so space repeated runs — three back to back earned a real 429 on 2026-09-14.

Counts as of 2026-09-14: 623 lines of server source (`wc -l index.ts server.ts`; `smoke.ts` is 277 more and is the live tier, and `scripts/bundle.mjs` 197 more and is build tooling, neither of them app code), 1,550 lines of tests (`wc -l test/*.ts`), 78 tests across 5 files — the number `npm test` reports. `grep -c "^\s*it(" test/*.ts` sums to 70, because two cases are table-driven: a `for` loop over three values, and an `it.each` over six that the pattern does not match at all. 70 + 2 + 6 = 78. Trust the runner.

What they cover:

- `test/server.test.ts` drives every tool through a real MCP client over the in-memory transport and asserts on the URLs and POST bodies sent to the mocked `fetch` and on the JSON returned: error surfacing (404, 429, non-JSON), the 75-identifier chunking in `card_collection`, the abort timeout, rate-limit serialization, the response cache (hit, never for `card_random`, never for errors), the 429/5xx retry and its attempt cap, argument validation before any request is issued (a non-string `set`, `order` or `q`, a non-boolean `full`, a `page` that is not a number or numeric string — none of them coerced into the URL — while a blank optional string means absent, which is what a client that fills every declared property sends), and that `card_search`'s outgoing `page` and echoed `page` are the same value.
- `test/retry-timing.test.ts` measures the retry waits on a fake clock, which is the only way to tell a honoured `Retry-After` from an ignored one — including that a honoured header never waits less than the backoff it replaced, so `Retry-After: 0` waits 250 ms on the first retry and 1000 ms on the second. It also measures the gap BETWEEN two calls across a retry: a retried call issues several requests, and the next queued call must be paced from the last of them, not from the first. Its own file because a fake clock advanced by N ms leaves the rate limiter's timestamp N ms in the future, and vitest isolates module state per file.
- `test/env-config.test.ts` re-imports the server with stubbed environment variables, since the knobs are read once at load: bad values falling back, `SCRYFALL_CACHE_TTL_MS=0` as the off switch, LRU eviction, the attempt cap still issuing a request, `SCRYFALL_MAX_ATTEMPTS=3000` rejected against the ceiling while a knob without one still takes that magnitude, and `SCRYFALL_CONTACT` reaching the `User-Agent` (including the empty-value fallback an optional bundle field produces).
- `test/bundle-manifest.test.ts` pins `manifest.json` against the code — entry point, the `user_config` wiring, the privacy policy, and the manifest's tool list against what `tools/list` actually serves. It also pins the version, which has four owners: `package.json`, `manifest.json`, the `serverInfo` literal in `server.ts` and the `User-Agent` product token. The last two are asserted through a live server, so a bump touching only the JSON files cannot pass.
- `test/no-http-stack.test.ts` pins that this repo's own source imports only the stdio transport and never an HTTP one (the SDK still pulls hono and express into the tree; that test does not and cannot prove they never load).

Nothing in `npm test` touches the network.

Mutation probe, 2026-09-11: changing `COLLECTION_MAX` in `server.ts` from 75 to 74 fails exactly one test, `card_collection chunks past Scryfall's 75-identifier cap and merges pages` (expected a length of 75 but got 74); the other 33 pass. Source restored after the run.

Mutation probes, re-run 2026-09-14 against the 78-test suite. Three on the retry layer, because those cases do not share one kill — a `null` return, an unguarded parse and a missing floor break different parts of it:

- `retryAfterMs` returning `null` fails three: the two asserting a honoured `Retry-After` (2 s, and the 10 s cap), and the one asserting a stale `Retry-After` is not carried into the next call. It leaves the `Retry-After: 0` cases green, correctly — ignoring the header and honouring a 0 now produce the same 250 ms wait, which is the invariant.
- Dropping the `Number.isFinite` guard fails exactly the HTTP-date case, which the first mutation leaves green.
- Dropping the `Math.max` floor where the wait is chosen fails exactly the two `Retry-After: 0` cases (first retry and second).
- Stamping the pacer once per tool call again (in `rateLimited`, instead of at each `fetch`) fails exactly the cross-call pacing case, measuring a 0 ms gap where 100 ms is required; the other 77 pass.

Three more on argument validation: neutering `optionalString`'s type check fails exactly the six `rejects a non-string optional argument` cases, 71 pass; restoring its blank-string rejection fails exactly the two blank-means-absent cases; reading `full` by bare truthiness again fails the two `card_search` boolean cases. Source restored after every run.

Call-count assertions (`toHaveBeenCalledTimes`, `not.toHaveBeenCalled`) appear at 28 sites — 18 in `test/server.test.ts`, 10 in `test/env-config.test.ts` (`grep -c "toHaveBeenCalledTimes\|not\.toHaveBeenCalled" test/*.ts`). Each one pins a contract: one POST per 75-chunk, no request on rejected input, cache hit vs miss, retry attempts, an env knob taking effect. Most sit next to an assertion on the payload or result; `never caches card_random` is the case where the call count is the only assertion, because two fetches *is* the not-cached contract. Policy: assert behavior and payloads, not that a function was called.

## API etiquette

Follows [Scryfall's guidelines](https://scryfall.com/docs/api): a 100 ms delay between requests, a descriptive `User-Agent`, and `Accept: application/json`. Between *requests*, not between tool calls — a retried call issues several, and each one advances the delay, so a call queued behind a retry still waits its 100 ms from that retry. `card_collection` never posts more than Scryfall's cap of 75 identifiers per request; chunked requests go through the same delay queue.

Backing off is part of that. A 429, any 5xx, and network or timeout failures are retried up to `SCRYFALL_MAX_ATTEMPTS` (3 by default, counting the first), with a 250 ms then 1000 ms backoff. A numeric `Retry-After` header replaces that backoff, capped at 10 s so an upstream number cannot wedge the queue and never shorter than the backoff it replaced — `Retry-After: 0` waits the 250 ms that attempt would have waited anyway, because honouring the header must not pace faster than ignoring it would; the HTTP-date form is ignored. Retries run inside the same serialized queue, so when Scryfall asks this process to slow down, every later call waits too. A 404 and other 4xx are **not** retried: "no such card" and "bad query" are real answers, and asking twice spends the rate limit to learn the same thing.

Requests time out after 15 s. GET responses are cached in memory, which Scryfall's guidelines also ask for; `/cards/random` never is.

## Limitations

- In-memory GET cache only (defaults and how to change them: Configuration above; `card_random` is never cached); nothing persists across restarts and there is no offline store. `bulk_default` lists the bulk-data endpoints; downloading them is the caller's job.
- **The npm package named `mcp-scryfall` is a different project.** That unscoped name was published by an unrelated maintainer in February 2025 and sits at 0.1.1 with its own `mcp-scryfall` bin, so `npx mcp-scryfall` runs that server, not this one. Install this one by cloning, or from the `.mcpb` bundle. Publishing from this repo under that name would 403; picking a scope is an open decision, not something to do quietly.
- Requests never run in parallel — everything funnels through the one 100 ms-spaced queue, so a large `card_collection` (sequential 75-identifier POSTs) takes proportionally longer. Each request times out after 15 s.
- Thin passthrough: beyond the compact summaries, results are Scryfall's data as returned — no legality checking, no rules logic.

## AI assistance

This project was built with AI assistance (Claude). Correctness is established by the mocked-transport test suite (`npm test` — every tool, error paths, chunking, throttle serialization; no network), a strict typecheck, a smoke run that spawns the real server over stdio and calls live Scryfall once per tool (`npm run smoke`), and daily real use for deckbuilding. I review the code and stand behind it.

## License

MIT © Abishai James. Card data © Scryfall; this project is unofficial and not affiliated with Scryfall or Wizards of the Coast.
