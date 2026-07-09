# mcp-scryfall

MCP server for live **Magic: The Gathering** card lookup via the [Scryfall API](https://scryfall.com/docs/api). Built on the [MCP TypeScript SDK](https://modelcontextprotocol.io).

LLMs misremember card names, costs, and rules text. This looks them up on live Scryfall instead. I use it daily for deckbuilding.

## Tools

| Tool | What it does |
|------|--------------|
| `card_named` | Exact-name lookup (optional set code). Full card object. |
| `card_fuzzy` | Fuzzy-name lookup. Handles typos and partial names. |
| `card_search` | [Scryfall query-syntax](https://scryfall.com/docs/syntax) search. Returns compact summaries by default (pass `full: true` for raw objects). |
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

Add it to your client's MCP config (e.g. Claude Desktop's `claude_desktop_config.json`):

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

## Example

`card_search` with `q = "c:rb cmc<=2 t:creature o:haste"` returns compact rows plus paging metadata:

```json
{
  "total_cards": 11,
  "has_more": false,
  "page": 1,
  "data": [
    { "name": "Dreadhorde Butcher", "mana_cost": "{B}{R}", "type_line": "Creature — Zombie Warrior", "cmc": 2, "set": "war" }
  ]
}
```

Pass `full: true` to get the raw Scryfall objects instead.

## Develop

```bash
npm test         # MCP-layer tests over an in-memory transport (fetch mocked, no network)
npm run smoke    # hit the live Scryfall API once per tool
npm run typecheck
```

## API etiquette

Follows [Scryfall's guidelines](https://scryfall.com/docs/api): a 100 ms delay between requests, a descriptive `User-Agent`, and `Accept: application/json`.

## License

MIT © Abishai James. Card data © Scryfall; this project is unofficial and not affiliated with Scryfall or Wizards of the Coast.
