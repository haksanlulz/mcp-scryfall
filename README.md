# mcp-scryfall

MCP server for live **Magic: The Gathering** card lookup via the [Scryfall API](https://scryfall.com/docs/api). Built on the [MCP TypeScript SDK](https://modelcontextprotocol.io).

LLMs misremember card names, costs, and rules text. This looks them up on live Scryfall instead. I use it daily for deckbuilding.

## Tools

| Tool | What it does |
|------|--------------|
| `card_named` | Exact-name lookup (optional set code). Full card object. |
| `card_fuzzy` | Fuzzy-name lookup. Handles typos and partial names. |
| `card_search` | [Scryfall query-syntax](https://scryfall.com/docs/syntax) search. Returns compact summaries (name, cost, type, `oracle_text`) by default (pass `full: true` for raw objects). |
| `card_collection` | Batch lookup (`POST /cards/collection`) — resolve a whole decklist in one call. Takes exact-name strings and/or `{name}` / `{id}` / `{name, set}` / `{set, collector_number}` identifiers; misses come back in `not_found`. |
| `card_random` | A random card, optionally filtered by a query. |
| `bulk_default` | Lists Scryfall bulk-data endpoints for offline corpus building. |

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
      "oracle_text": "Haste\nWhenever this creature deals combat damage to a player or planeswalker, put a +1/+1 counter on this creature.\nWhen this creature dies, it deals damage equal to its power to any target."
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
    { "name": "Lightning Bolt", "mana_cost": "{R}", "type_line": "Instant", "cmc": 1, "set": "msc", "oracle_text": "Lightning Bolt deals 3 damage to any target." },
    { "name": "Counterspell", "mana_cost": "{U}{U}", "type_line": "Instant", "cmc": 2, "set": "dsc", "oracle_text": "Counter target spell." }
  ]
}
```

Scryfall caps one collection POST at 75 identifiers; longer lists are split into sequential rate-limited POSTs automatically, so a 100-card decklist is one tool call (two requests under the hood).

Pass `full: true` to either tool to get the raw Scryfall objects instead.

## Develop

```bash
npm test         # MCP-layer tests over an in-memory transport (fetch mocked, no network)
npm run smoke    # hit the live Scryfall API once per tool
npm run typecheck
```

## API etiquette

Follows [Scryfall's guidelines](https://scryfall.com/docs/api): a 100 ms delay between requests, a descriptive `User-Agent`, and `Accept: application/json`. `card_collection` never posts more than Scryfall's cap of 75 identifiers per request; chunked requests go through the same delay queue.

## Limitations

- No caching, no offline store: every call is a live Scryfall request. `bulk_default` lists the bulk-data endpoints; downloading them is the caller's job.
- Requests never run in parallel — everything funnels through the one 100 ms-spaced queue, so a large `card_collection` (sequential 75-identifier POSTs) takes proportionally longer. Each request times out after 15 s.
- Thin passthrough: beyond the compact summaries, results are Scryfall's data as returned — no legality checking, no rules logic.

## AI assistance

This project was built with AI assistance (Claude). Correctness is established by the mocked-transport test suite (`npm test` — every tool, error paths, chunking, throttle serialization; no network), a strict typecheck, live per-tool smoke runs against Scryfall (`npm run smoke`), and daily real use for deckbuilding. I review the code and stand behind it.

## License

MIT © Abishai James. Card data © Scryfall; this project is unofficial and not affiliated with Scryfall or Wizards of the Coast.
