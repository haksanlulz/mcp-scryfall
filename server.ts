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
const UA = `mcp-scryfall/1.1 (${CONTACT})`;
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

// Scryfall's API guidelines ask clients to cache; card data is effectively static
// between set releases, so a repeat lookup should not cost a request. Cached in
// memory only: an MCP server is a short-lived child process, and a disk cache would
// need invalidation logic to buy anything a process lifetime does not already give.
//
// GET only. POST is card_collection, whose body is the cache key's real content, and
// /cards/random must never be served from cache or it stops being random.
const CACHE_TTL_MS = Number(process.env.SCRYFALL_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000);
const CACHE_MAX = Number(process.env.SCRYFALL_CACHE_MAX ?? 500);
const cache = new Map<string, { at: number; value: any }>();

function cacheable(path: string, body?: unknown): boolean {
  return body === undefined && !path.startsWith("/cards/random") && CACHE_TTL_MS > 0;
}

function cacheGet(path: string): any | undefined {
  const hit = cache.get(path);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(path);
    return undefined;
  }
  // refresh recency: re-inserting moves the key to the end of Map iteration order,
  // which is what makes the eviction below least-recently-used rather than oldest-written
  cache.delete(path);
  cache.set(path, hit);
  return hit.value;
}

function cacheSet(path: string, value: any): void {
  cache.set(path, { at: Date.now(), value });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

// exported for tests: a cache that cannot be cleared makes every later test depend
// on the order of the ones before it
export function clearScryfallCache(): void {
  cache.clear();
}

// single owner of the fetch shape (UA, Accept, timeout, JSON + error handling);
// GET by default, POST with a JSON body when one is given
async function scryfallRequest(path: string, body?: unknown): Promise<any> {
  if (cacheable(path, body)) {
    const hit = cacheGet(path);
    // a cache hit skips the rate limiter too: nothing leaves the process, so
    // there is no Scryfall request to pace
    if (hit !== undefined) return hit;
  }
  return rateLimited(async () => {
    return attemptWithRetry(path, body);
  });
}

// Scryfall asks clients to back off on 429. A single one used to fail the whole
// tool call, as did any transient 5xx or dropped connection -- the 100ms pacer
// makes those rare, not impossible, since it only paces THIS process and the
// rate limit is per IP.
//
// Retried: 429, 5xx, and network/timeout errors. NOT retried: 404 and other 4xx,
// because "no such card" and "bad query" are real answers and repeating them just
// spends the rate limit twice. Runs inside the serialized queue on purpose -- if
// Scryfall is asking us to slow down, every later call should wait too.
const MAX_ATTEMPTS = Number(process.env.SCRYFALL_MAX_ATTEMPTS ?? 3);
const BACKOFF_MS = [250, 1000];

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  // Retry-After is seconds or an HTTP date; only the numeric form is worth honouring
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs * 1000, 10_000) : null;
}

async function attemptWithRetry(path: string, body?: unknown): Promise<any> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const wait = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
      await new Promise((r) => setTimeout(r, pendingRetryAfter ?? wait));
      pendingRetryAfter = null;
    }
    try {
      return await attemptOnce(path, body);
    } catch (err) {
      lastError = err;
      if (!(err instanceof RetryableError)) throw err;
    }
  }
  throw lastError instanceof RetryableError ? lastError.cause : lastError;
}

// Carries the underlying error so the caller sees Scryfall's own message, not a
// wrapper that hides which request actually failed.
class RetryableError extends Error {
  constructor(readonly cause: Error) {
    super(cause.message);
  }
}
let pendingRetryAfter: number | null = null;

async function attemptOnce(path: string, body?: unknown): Promise<any> {
  {
    let res: Response;
    try {
      res = await fetch(`${SCRYFALL}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // bound every request: without this a single hung fetch wedges the whole
        // serialized queue and blocks every later tool call for the process lifetime
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // A dropped connection or the 15s timeout: transient by nature, so worth one
      // more try rather than surfacing as a hard failure to the model.
      throw new RetryableError(err instanceof Error ? err : new Error(String(err)));
    }
    const raw = await res.text();
    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(
        `Scryfall ${path} returned non-JSON (status ${res.status}): ${raw.slice(0, 200)}`,
      );
    }
    if (!res.ok) {
      // Scryfall error bodies are {object:"error", code, status, details}; surface details
      // NOTE: thrown before any cacheSet, so an error is never cached
      const detail = json?.details ?? raw.slice(0, 200);
      const err = new Error(`Scryfall ${path} error (status ${res.status}): ${detail}`);
      if (res.status === 429 || res.status >= 500) {
        pendingRetryAfter = retryAfterMs(res);
        throw new RetryableError(err);
      }
      throw err;
    }
    if (cacheable(path, body)) cacheSet(path, json);
    return json;
  }
}

// Keys are always present (null when the card has no value) so a caller can
// tell "this card has no power" from "this field wasn't returned".
function summarizeCard(card: any) {
  return {
    name: card.name,
    // double-faced cards carry mana_cost per face, not top-level
    mana_cost:
      card.mana_cost ??
      card.card_faces?.map((f: any) => f.mana_cost).filter(Boolean).join(" // ") ??
      null,
    type_line: card.type_line ?? null,
    cmc: card.cmc ?? null,
    set: card.set ?? null,
    collector_number: card.collector_number ?? null,
    // rules text is the point of this server; without it every summary row
    // costs a card_named round-trip. Same per-face fallback as mana_cost,
    // joined with the divider on its own line since faces are multi-line prose.
    oracle_text:
      card.oracle_text ??
      card.card_faces?.map((f: any) => f.oracle_text).filter(Boolean).join("\n//\n") ??
      null,
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    color_identity: card.color_identity ?? null,
    // the one legality worth carrying inline: deck-list checking is the common
    // batch use, and the full legalities map is ~20 keys of mostly noise
    legal_commander: card.legalities?.commander ?? null,
  };
}

// Scryfall caps POST /cards/collection at 75 identifiers per request
const COLLECTION_MAX = 75;

// strings are a {name} shorthand; objects pass through as Scryfall identifiers
// ({name}, {id}, {name, set}, {set, collector_number}, ...) for Scryfall to validate
function toIdentifier(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    const name = raw.trim();
    if (name) return { name };
  } else if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length > 0) {
    return raw as Record<string, unknown>;
  }
  throw new Error(
    `card_collection: invalid identifier ${JSON.stringify(raw)} — expected a card-name string or an identifier object like {name}, {id}, or {set, collector_number}`,
  );
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
    name: "card_collection",
    description:
      "Batch lookup of many cards in one call (POST /cards/collection) — use this for decklists instead of one card_named call per card. Identifiers are exact-name strings (not fuzzy) and/or Scryfall identifier objects: {name}, {id}, {name, set}, {set, collector_number}. Scryfall caps one POST at 75 identifiers; longer lists are chunked into sequential rate-limited POSTs transparently. Returns {requested, found, not_found, data}: check not_found — it lists the identifiers Scryfall could not resolve. data holds compact summaries (with oracle_text) by default; pass full:true for raw card objects.",
    inputSchema: {
      type: "object",
      properties: {
        identifiers: {
          type: "array",
          minItems: 1,
          description:
            "Cards to fetch: exact-name strings and/or identifier objects ({name}, {id}, {name, set}, {set, collector_number})",
          items: {
            anyOf: [
              { type: "string", description: "Exact card name" },
              {
                type: "object",
                description:
                  "Scryfall identifier object: {name}, {id}, {name, set}, or {set, collector_number}",
                properties: {
                  name: { type: "string", description: "Exact card name" },
                  id: { type: "string", description: "Scryfall card UUID" },
                  set: { type: "string", description: "Set code (with name or collector_number)" },
                  collector_number: { type: "string", description: "Collector number (with set)" },
                },
              },
            ],
          },
        },
        full: {
          type: "boolean",
          description: "Return raw Scryfall card objects instead of compact summaries (default false)",
        },
      },
      required: ["identifiers"],
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
    name: "card_rulings",
    description:
      "Official Wizards/Scryfall rulings for one card — the errata and corner-case answers that are not in the oracle text. Give an exact name (resolved via an exact lookup first) or a Scryfall card id to skip that hop. Returns Scryfall's rulings list {object:'list', data:[{published_at, comment, source}]}; empty data means the card has no rulings, which is itself an answer.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Exact card name" },
        id: { type: "string", description: "Scryfall card id (skips the name-resolution request)" },
      },
    },
  },
  {
    name: "bulk_default",
    description:
      "List Scryfall bulk-data endpoints. Returns an array of items carrying type, name, updated_at, compressed_size and jsonl_download_uri; the caller fetches jsonl_download_uri directly. Payloads are gzipped JSONL — one card object per line, not a single JSON array. Useful for offline corpus building.",
    inputSchema: { type: "object", properties: {} },
  },
];

export function createServer(): Server {
  const server = new Server(
    { name: "mcp-scryfall", version: "1.1.0" },
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
        return asText(await scryfallRequest(path));
      }
      case "card_fuzzy": {
        const n = encodeURIComponent(String(args.name));
        return asText(await scryfallRequest(`/cards/named?fuzzy=${n}`));
      }
      case "card_search": {
        const q = encodeURIComponent(String(args.q));
        const page = args.page ? `&page=${Number(args.page)}` : "";
        const order = args.order
          ? `&order=${encodeURIComponent(String(args.order))}`
          : "";
        const data: any = await scryfallRequest(`/cards/search?q=${q}${page}${order}`);
        // summaries by default: full objects on a broad search burn tokens; full:true for raw
        if (args.full || data?.object === "error") return asText(data);
        return asText({
          total_cards: data?.total_cards,
          has_more: data?.has_more,
          page: Number(args.page ?? 1),
          data: Array.isArray(data?.data) ? data.data.map(summarizeCard) : [],
        });
      }
      case "card_collection": {
        if (!Array.isArray(args.identifiers) || args.identifiers.length === 0) {
          throw new Error(
            "card_collection requires a non-empty identifiers array (card-name strings or identifier objects)",
          );
        }
        const identifiers = args.identifiers.map(toIdentifier);
        // >75 identifiers: sequential POSTs through the same rate-limited queue,
        // merged back into one response
        const found: any[] = [];
        const notFound: any[] = [];
        for (let i = 0; i < identifiers.length; i += COLLECTION_MAX) {
          const chunk = identifiers.slice(i, i + COLLECTION_MAX);
          const page: any = await scryfallRequest("/cards/collection", {
            identifiers: chunk,
          });
          if (Array.isArray(page?.data)) found.push(...page.data);
          if (Array.isArray(page?.not_found)) notFound.push(...page.not_found);
        }
        // not_found leads so a decklist miss can't hide under dozens of hits
        return asText({
          requested: identifiers.length,
          found: found.length,
          not_found: notFound,
          data: args.full ? found : found.map(summarizeCard),
        });
      }
      case "card_random": {
        let path = "/cards/random";
        if (args.q) path += `?q=${encodeURIComponent(String(args.q))}`;
        return asText(await scryfallRequest(path));
      }
      case "card_rulings": {
        let id = args.id ? String(args.id).trim() : "";
        if (!id) {
          const name = args.name ? String(args.name).trim() : "";
          if (!name) throw new Error("card_rulings needs a name or a Scryfall id");
          // resolve exact -> id; a miss throws out of scryfallRequest with
          // Scryfall's own details rather than returning empty rulings, which
          // would read as "this card has no rulings"
          const card = await scryfallRequest(`/cards/named?exact=${encodeURIComponent(name)}`);
          id = String(card.id);
        }
        return asText(await scryfallRequest(`/cards/${encodeURIComponent(id)}/rulings`));
      }
      case "bulk_default":
        return asText(await scryfallRequest("/bulk-data"));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}
