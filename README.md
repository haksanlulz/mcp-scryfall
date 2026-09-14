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

`SCRYFALL_CONTACT` is optional; it is added to the `User-Agent` per Scryfall's API guidelines.

## Examples

Shapes below are exact; the volatile values (`total_cards`, latest-printing `set` codes) are whatever Scryfall returned when this was written.

`card_search` with `q = "c:rb cmc<=2 t:creature o:haste"` returns compact rows — rules text included — plus paging metadata:

```json
{
  "total_cards": 11,
  "has_more": false,
  "page": 1,
  "data": [
    {
      "name": "Dreadhorde Butcher",
      "mana_cost": "{B}{R}",
      "type_line": "Creature — Zombie Warrior",
      "cmc": 2,
      "set": "war",
      "collector_number": "189",
      "oracle_text": "Haste\nWhenever this creature deals combat damage to a player or planeswalker, put a +1/+1 counter on this creature.\nWhen this creature dies, it deals damage equal to its power to any target.",
      "power": "2",
      "toughness": "2",
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
    { "name": "Lightning Bolt", "mana_cost": "{R}", "type_line": "Instant", "cmc": 1, "set": "msc", "collector_number": "128", "oracle_text": "Lightning Bolt deals 3 damage to any target.", "power": null, "toughness": null, "color_identity": ["R"], "legal_commander": "legal" },
    { "name": "Counterspell", "mana_cost": "{U}{U}", "type_line": "Instant", "cmc": 2, "set": "dsc", "collector_number": "58", "oracle_text": "Counter target spell.", "power": null, "toughness": null, "color_identity": ["U"], "legal_commander": "legal" }
  ]
}
```

Scryfall caps one collection POST at 75 identifiers; longer lists are split into sequential rate-limited POSTs automatically, so a 100-card decklist is one tool call (two requests under the hood).

Pass `full: true` to either tool to get the raw Scryfall objects instead.

## Testing

```bash
npm test         # offline: vitest over an in-memory MCP transport, fetch mocked, no network
npm run smoke    # live: spawns the real server over stdio and calls Scryfall once per tool
npm run typecheck
```

Two tiers, split by script rather than by marker. `npm test` is the gate; `npm run smoke` is a manual check against the live API.

Counts as of 2026-09-11: 455 lines of server source (`wc -l index.ts server.ts`; `smoke.ts` is 242 more and is the live tier, not app code), 744 lines of tests (`wc -l test/*.ts`), 34 tests across 2 files (`grep -c "^\s*it(" test/*.ts`).

What they cover: `test/server.test.ts` drives every tool through a real MCP client over the in-memory transport and asserts on the URLs and POST bodies sent to the mocked `fetch` and on the JSON returned, including error surfacing (404, 429, non-JSON), the 75-identifier chunking in `card_collection`, the abort timeout, rate-limit serialization, the response cache (hit, never for `card_random`, never for errors) and the 429/5xx retry with its attempt cap. `test/no-http-stack.test.ts` pins that this repo's own source imports only the stdio transport and never an HTTP one (the SDK still pulls hono and express into the tree; that test does not and cannot prove they never load). Nothing here touches the network.

Mutation probe, 2026-09-11: changing `COLLECTION_MAX` in `server.ts` from 75 to 74 fails exactly one test, `card_collection chunks past Scryfall's 75-identifier cap and merges pages` (expected a length of 75 but got 74); the other 33 pass. Source restored after the run.

Call-count assertions (`toHaveBeenCalledTimes`, `not.toHaveBeenCalled`) appear at 10 sites; each one pins a contract (one POST per 75-chunk, no request on rejected input, cache hit vs miss, retry attempts). Nine sit next to an assertion on the payload or result; the tenth (`card_random` is never cached) has the call count as its only assertion, because two fetches is the not-cached contract. Policy: assert behavior and payloads, not that a function was called.

## API etiquette

Follows [Scryfall's guidelines](https://scryfall.com/docs/api): a 100 ms delay between requests, a descriptive `User-Agent`, and `Accept: application/json`. `card_collection` never posts more than Scryfall's cap of 75 identifiers per request; chunked requests go through the same delay queue.

## Limitations

- In-memory GET cache only (24 h TTL by default, 500-entry LRU cap, `card_random` excluded); nothing persists across restarts and there is no offline store. `bulk_default` lists the bulk-data endpoints; downloading them is the caller's job.
- Requests never run in parallel — everything funnels through the one 100 ms-spaced queue, so a large `card_collection` (sequential 75-identifier POSTs) takes proportionally longer. Each request times out after 15 s.
- Thin passthrough: beyond the compact summaries, results are Scryfall's data as returned — no legality checking, no rules logic.

## AI assistance

This project was built with AI assistance (Claude). Correctness is established by the mocked-transport test suite (`npm test` — every tool, error paths, chunking, throttle serialization; no network), a strict typecheck, a smoke run that spawns the real server over stdio and calls live Scryfall once per tool (`npm run smoke`), and daily real use for deckbuilding. I review the code and stand behind it.

## License

MIT © Abishai James. Card data © Scryfall; this project is unofficial and not affiliated with Scryfall or Wizards of the Coast.
