import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// scryfall etiquette: ~100ms between requests + descriptive UA; SCRYFALL_CONTACT env adds a contact
const SCRYFALL = "https://api.scryfall.com";
// || not ?? because an empty SCRYFALL_CONTACT would still need the fallback
const CONTACT =
  process.env.SCRYFALL_CONTACT || "https://github.com/haksanlulz/mcp-scryfall";
const UA = `mcp-scryfall/1.0 (${CONTACT})`;
const DELAY_MS = 100;

// serialize through one chain: the SDK dispatches handlers concurrently, so a
// bare timestamp check would let parallel calls fire together and breach the delay
let lastCall = 0;
let queue: Promise<unknown> = Promise.resolve();
function rateLimited<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const elapsed = Date.now() - lastCall;
    if (elapsed < DELAY_MS) {
      await new Promise((r) => setTimeout(r, DELAY_MS - elapsed));
    }
    lastCall = Date.now();
    return fn();
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function scryfallGet(path: string): Promise<any> {
  return rateLimited(async () => {
    const res = await fetch(`${SCRYFALL}${path}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      // bound every request: without this a single hung fetch wedges the whole
      // serialized queue and blocks every later tool call for the process lifetime
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    let json: any;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(
        `Scryfall ${path} returned non-JSON (status ${res.status}): ${body.slice(0, 200)}`,
      );
    }
    if (!res.ok) {
      // Scryfall error bodies are {object:"error", code, status, details}; surface details
      const detail = json?.details ?? body.slice(0, 200);
      throw new Error(`Scryfall ${path} error (status ${res.status}): ${detail}`);
    }
    return json;
  });
}

function summarizeCard(card: any) {
  return {
    name: card.name,
    // double-faced cards carry mana_cost per face, not top-level
    mana_cost:
      card.mana_cost ??
      card.card_faces?.map((f: any) => f.mana_cost).filter(Boolean).join(" // "),
    type_line: card.type_line,
    cmc: card.cmc,
    set: card.set,
  };
}

function asText(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const TOOLS = [
  {
    name: "card_named",
    description:
      "Exact-name lookup of a Magic card. Returns the full Scryfall card object (oracle_text, mana_cost, type_line, P/T, legalities, etc.) on a hit. A miss (no card by that exact name) surfaces as an error carrying Scryfall's details; try card_fuzzy instead. Use when the caller has the exact card name.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact card name (case-insensitive)" },
        set: {
          type: "string",
          description: "Optional 3-letter set code (e.g. 'mh2'); restricts to that printing",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "card_fuzzy",
    description:
      "Fuzzy-name lookup of a Magic card. Handles typos, partial names, and alternate spellings. Returns the full card object; no close match surfaces as an error carrying Scryfall's details. Use when the caller's spelling may be wrong or incomplete.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Approximate card name" },
      },
      required: ["name"],
    },
  },
  {
    name: "card_search",
    description:
      "Scryfall query-syntax search (e.g. 'is:fetchland t:land', 'c:rb cmc<=2 t:creature', 'o:\"draw a card\" pow=1'). Returns compact per-card summaries plus total_cards/has_more by default to keep responses small; pass full:true for the raw Scryfall response. Full syntax: https://scryfall.com/docs/syntax",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Scryfall query string" },
        page: { type: "number", description: "Page number (1-indexed, default 1)" },
        order: {
          type: "string",
          description: "Sort order: name, cmc, color, released, etc. (default: name)",
        },
        full: {
          type: "boolean",
          description: "Return the raw Scryfall response instead of compact summaries (default false)",
        },
      },
      required: ["q"],
    },
  },
  {
    name: "card_random",
    description:
      "A random Magic card. An optional q= filter uses the same Scryfall query syntax as card_search. Returns the full card object.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Optional Scryfall query to restrict the random pool" },
      },
    },
  },
  {
    name: "bulk_default",
    description:
      "List Scryfall bulk-data endpoints. Returns an array of {type, name, download_uri, size, updated_at}; the caller fetches download_uri directly for the full oracle-text JSON dumps. Useful for offline corpus building.",
    inputSchema: { type: "object", properties: {} },
  },
];

export function createServer(): Server {
  const server = new Server(
    { name: "mcp-scryfall", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    switch (name) {
      case "card_named": {
        const n = encodeURIComponent(String(args.name));
        let path = `/cards/named?exact=${n}`;
        if (args.set) path += `&set=${encodeURIComponent(String(args.set))}`;
        return asText(await scryfallGet(path));
      }
      case "card_fuzzy": {
        const n = encodeURIComponent(String(args.name));
        return asText(await scryfallGet(`/cards/named?fuzzy=${n}`));
      }
      case "card_search": {
        const q = encodeURIComponent(String(args.q));
        const page = args.page ? `&page=${Number(args.page)}` : "";
        const order = args.order
          ? `&order=${encodeURIComponent(String(args.order))}`
          : "";
        const data: any = await scryfallGet(`/cards/search?q=${q}${page}${order}`);
        // summaries by default: full objects on a broad search burn tokens; full:true for raw
        if (args.full || data?.object === "error") return asText(data);
        return asText({
          total_cards: data?.total_cards,
          has_more: data?.has_more,
          page: Number(args.page ?? 1),
          data: Array.isArray(data?.data) ? data.data.map(summarizeCard) : [],
        });
      }
      case "card_random": {
        let path = "/cards/random";
        if (args.q) path += `?q=${encodeURIComponent(String(args.q))}`;
        return asText(await scryfallGet(path));
      }
      case "bulk_default":
        return asText(await scryfallGet("/bulk-data"));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}
