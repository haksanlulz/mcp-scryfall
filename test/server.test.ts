import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

async function connect(): Promise<Client> {
  const server = createServer();
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function mockFetch(payload: unknown, status = 200) {
  // declare the fetch(url, init) params so mock.calls[0][0] is a typed URL, not an empty tuple
  return vi.fn(async (_url?: any, _init?: any) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function bodyOf(res: any) {
  return JSON.parse(res.content[0].text);
}

describe("mcp-scryfall server", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exposes all seven tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "bulk_default",
      "card_collection",
      "card_fuzzy",
      "card_named",
      "card_random",
      "card_rulings",
      "card_search",
    ]);
  });

  it("card_named builds the exact-name URL and returns the card", async () => {
    const fetchMock = mockFetch({ object: "card", name: "Black Lotus", set: "lea" });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({
      name: "card_named",
      arguments: { name: "Black Lotus" },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/cards/named?exact=Black%20Lotus",
    );
    expect(bodyOf(res).name).toBe("Black Lotus");
  });

  it("card_named appends the set code when given", async () => {
    const fetchMock = mockFetch({ object: "card", name: "Lightning Bolt", set: "2x2" });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({
      name: "card_named",
      arguments: { name: "Lightning Bolt", set: "2x2" },
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/cards/named?exact=Lightning%20Bolt");
    expect(url).toContain("&set=2x2");
    expect(bodyOf(res).set).toBe("2x2");
  });

  it("card_fuzzy builds the fuzzy-name URL and returns the card", async () => {
    const fetchMock = mockFetch({ object: "card", name: "Jace Beleren" });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({
      name: "card_fuzzy",
      arguments: { name: "jace belren" },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/cards/named?fuzzy=jace%20belren",
    );
    expect(bodyOf(res).name).toBe("Jace Beleren");
  });

  it("card_search returns compact summaries by default", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        object: "list",
        total_cards: 2,
        has_more: false,
        data: [
          {
            name: "Ash Zealot",
            mana_cost: "{R}{R}",
            type_line: "Creature — Goblin Berserker",
            cmc: 2,
            set: "rtr",
            oracle_text: "First strike, haste",
          },
          {
            name: "Goblin Guide",
            mana_cost: "{R}",
            type_line: "Creature — Goblin Scout",
            cmc: 1,
            set: "zen",
            oracle_text: "Haste",
          },
        ],
      }),
    );
    const client = await connect();
    const res = await client.callTool({
      name: "card_search",
      arguments: { q: "t:goblin" },
    });
    const out = bodyOf(res);
    expect(out.total_cards).toBe(2);
    expect(out.data).toHaveLength(2);
    // oracle_text rides along in summaries: rules-text grounding is the point,
    // and omitting it forced a card_named round-trip per result
    expect(out.data[0]).toEqual({
      name: "Ash Zealot",
      mana_cost: "{R}{R}",
      type_line: "Creature — Goblin Berserker",
      cmc: 2,
      set: "rtr",
      collector_number: null,
      oracle_text: "First strike, haste",
      power: null,
      toughness: null,
      color_identity: null,
      legal_commander: null,
    });
    expect(out.data[1].oracle_text).toBe("Haste");
  });

  it("card_search full:true returns the raw response", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        object: "list",
        total_cards: 1,
        has_more: false,
        data: [{ name: "Ash Zealot", oracle_text: "First strike, haste" }],
      }),
    );
    const client = await connect();
    const res = await client.callTool({
      name: "card_search",
      arguments: { q: "t:goblin", full: true },
    });
    expect(bodyOf(res).data[0].oracle_text).toBe("First strike, haste");
  });

  it("card_search pulls mana_cost and oracle_text from card_faces for double-faced cards", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        object: "list",
        total_cards: 1,
        has_more: false,
        data: [
          {
            name: "Huntmaster of the Fells // Ravager of the Fells",
            type_line: "Creature — Human Werewolf // Creature — Werewolf",
            cmc: 4,
            set: "dka",
            card_faces: [
              { mana_cost: "{2}{R}{G}", oracle_text: "Front face text." },
              { mana_cost: "", oracle_text: "Back face text." },
            ],
          },
        ],
      }),
    );
    const client = await connect();
    const res = await client.callTool({
      name: "card_search",
      arguments: { q: "t:werewolf" },
    });
    const card = bodyOf(res).data[0];
    expect(card.mana_cost).toBe("{2}{R}{G}");
    // faces join on a line of their own so multi-line rules text stays readable
    expect(card.oracle_text).toBe("Front face text.\n//\nBack face text.");
  });

  it("card_search summaries null out fields the card truly lacks, rather than dropping them", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        object: "list",
        total_cards: 1,
        has_more: false,
        data: [{ name: "Oddity", type_line: "Artifact", cmc: 0, set: "xxx" }],
      }),
    );
    const client = await connect();
    const res = await client.callTool({
      name: "card_search",
      arguments: { q: "oddity" },
    });
    const card = bodyOf(res).data[0];
    // present-but-null, so a caller can tell "no power" from "field not returned"
    expect(card).toHaveProperty("oracle_text", null);
    expect(card).toHaveProperty("power", null);
    expect(card).toHaveProperty("legal_commander", null);
  });

  it("card_random hits /cards/random with no query by default", async () => {
    const fetchMock = mockFetch({ object: "card", name: "Forest" });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({ name: "card_random", arguments: {} });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/cards/random");
    expect(url).not.toContain("?q=");
    expect(bodyOf(res).name).toBe("Forest");
  });

  it("card_random forwards an optional q filter", async () => {
    const fetchMock = mockFetch({ object: "card", name: "Goblin Guide" });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    await client.callTool({ name: "card_random", arguments: { q: "t:goblin" } });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/cards/random?q=t%3Agoblin");
  });

  it("bulk_default lists the bulk-data endpoints", async () => {
    const fetchMock = mockFetch({
      object: "list",
      has_more: false,
      data: [
        {
          type: "oracle_cards",
          name: "Oracle Cards",
          download_uri: "https://data.scryfall.io/oracle-cards/oracle.json",
          size: 145000000,
          updated_at: "2026-07-11T00:00:00.000Z",
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({ name: "bulk_default", arguments: {} });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/bulk-data");
    const body = bodyOf(res);
    expect(body.data[0].type).toBe("oracle_cards");
    expect(body.data[0].download_uri).toContain("scryfall.io");
  });

  it("card_collection POSTs normalized identifiers and returns summaries with counts", async () => {
    const fetchMock = mockFetch({
      object: "list",
      not_found: [],
      data: [
        {
          name: "Lightning Bolt",
          mana_cost: "{R}",
          type_line: "Instant",
          cmc: 1,
          set: "clu",
          oracle_text: "Lightning Bolt deals 3 damage to any target.",
          legalities: { modern: "legal" },
        },
        {
          name: "Counterspell",
          mana_cost: "{U}{U}",
          type_line: "Instant",
          cmc: 2,
          set: "clu",
          oracle_text: "Counter target spell.",
          legalities: { modern: "legal" },
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({
      name: "card_collection",
      arguments: {
        identifiers: [
          "Lightning Bolt",
          { id: "9bc7f7c2-1b6c-4954-a05c-24014d72f66e" },
          { set: "clu", collector_number: "141" },
        ],
      },
    });
    // one POST to /cards/collection with JSON body; strings normalize to {name}
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/cards/collection");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      identifiers: [
        { name: "Lightning Bolt" },
        { id: "9bc7f7c2-1b6c-4954-a05c-24014d72f66e" },
        { set: "clu", collector_number: "141" },
      ],
    });
    const out = bodyOf(res);
    expect(out.requested).toBe(3);
    expect(out.found).toBe(2);
    expect(out.not_found).toEqual([]);
    // summaries carry the grounding fields but not full-object baggage like
    // the whole legalities map — commander legality is lifted out on its own
    expect(out.data[0]).toEqual({
      name: "Lightning Bolt",
      mana_cost: "{R}",
      type_line: "Instant",
      cmc: 1,
      set: "clu",
      collector_number: null,
      oracle_text: "Lightning Bolt deals 3 damage to any target.",
      power: null,
      toughness: null,
      color_identity: null,
      legal_commander: null,
    });
    expect(out.data[1].legalities).toBeUndefined();
  });

  it("card_collection chunks past Scryfall's 75-identifier cap and merges pages", async () => {
    const page = (cardName: string, missName: string) =>
      new Response(
        JSON.stringify({
          object: "list",
          not_found: [{ name: missName }],
          data: [{ name: cardName, type_line: "Instant", cmc: 1, set: "xxx", oracle_text: "Text." }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const fetchMock = vi
      .fn<(url?: any, init?: any) => Promise<Response>>()
      .mockImplementationOnce(async () => page("Card A", "Bogus One"))
      .mockImplementationOnce(async () => page("Card B", "Bogus Two"));
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const identifiers = Array.from({ length: 100 }, (_, i) => `Card ${i + 1}`);
    const res = await client.callTool({
      name: "card_collection",
      arguments: { identifiers },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(firstBody.identifiers).toHaveLength(75);
    expect(secondBody.identifiers).toHaveLength(25);
    expect(firstBody.identifiers[0]).toEqual({ name: "Card 1" });
    expect(secondBody.identifiers[0]).toEqual({ name: "Card 76" });
    const out = bodyOf(res);
    expect(out.requested).toBe(100);
    expect(out.found).toBe(2);
    expect(out.not_found).toEqual([{ name: "Bogus One" }, { name: "Bogus Two" }]);
    expect(out.data.map((c: any) => c.name)).toEqual(["Card A", "Card B"]);
  });

  it("card_collection surfaces not_found ahead of the data", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        object: "list",
        not_found: [{ name: "Zzzz Nonsense" }],
        data: [
          { name: "Lightning Bolt", mana_cost: "{R}", type_line: "Instant", cmc: 1, set: "clu", oracle_text: "Lightning Bolt deals 3 damage to any target." },
        ],
      }),
    );
    const client = await connect();
    const res = await client.callTool({
      name: "card_collection",
      arguments: { identifiers: ["Lightning Bolt", "Zzzz Nonsense"] },
    });
    const out = bodyOf(res);
    expect(out.requested).toBe(2);
    expect(out.found).toBe(1);
    expect(out.not_found).toEqual([{ name: "Zzzz Nonsense" }]);
    // not_found leads the envelope so a decklist miss can't hide under 74 hits
    expect(Object.keys(out)).toEqual(["requested", "found", "not_found", "data"]);
  });

  it("card_collection full:true returns raw card objects", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        object: "list",
        not_found: [],
        data: [
          {
            name: "Lightning Bolt",
            oracle_text: "Lightning Bolt deals 3 damage to any target.",
            legalities: { modern: "legal" },
          },
        ],
      }),
    );
    const client = await connect();
    const res = await client.callTool({
      name: "card_collection",
      arguments: { identifiers: ["Lightning Bolt"], full: true },
    });
    const out = bodyOf(res);
    expect(out.data[0].legalities).toEqual({ modern: "legal" });
    expect(out.not_found).toEqual([]);
  });

  it("card_collection propagates a POST error with Scryfall's details", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        {
          object: "error",
          code: "bad_request",
          status: 400,
          details: "All of your identifiers were invalid.",
        },
        400,
      ),
    );
    const client = await connect();
    await expect(
      client.callTool({
        name: "card_collection",
        arguments: { identifiers: ["Lightning Bolt"] },
      }),
    ).rejects.toThrow(/All of your identifiers were invalid/);
  });

  it("card_collection rejects bad input before any request", async () => {
    const fetchMock = mockFetch({ object: "list", not_found: [], data: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    await expect(
      client.callTool({ name: "card_collection", arguments: { identifiers: [] } }),
    ).rejects.toThrow(/non-empty/);
    await expect(
      client.callTool({ name: "card_collection", arguments: { identifiers: [42] } }),
    ).rejects.toThrow(/invalid identifier/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws with Scryfall's detail on a 429 rate-limit error", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ object: "error", status: 429, details: "rate limited" }, 429),
    );
    const client = await connect();
    await expect(
      client.callTool({ name: "card_named", arguments: { name: "Black Lotus" } }),
    ).rejects.toThrow(/rate limited/);
  });

  it("card_named surfaces a miss (404) as an error carrying the detail", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        { object: "error", status: 404, code: "not_found", details: "No cards found matching zzznotacard." },
        404,
      ),
    );
    const client = await connect();
    await expect(
      client.callTool({ name: "card_named", arguments: { name: "zzznotacard" } }),
    ).rejects.toThrow(/No cards found/);
  });

  it("throws a non-JSON error including the status when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    const client = await connect();
    await expect(
      client.callTool({ name: "card_random", arguments: {} }),
    ).rejects.toThrow(/non-JSON \(status 502\)/);
  });

  it("card_rulings resolves a name to an id, then fetches that card's rulings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: "card", id: "abc-123", name: "Black Lotus" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ published_at: "2004-10-04", comment: "A ruling.", source: "wotc" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({
      name: "card_rulings",
      arguments: { name: "Black Lotus" },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/cards/named?exact=Black%20Lotus");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/cards/abc-123/rulings");
    expect(bodyOf(res).data[0].comment).toBe("A ruling.");
  });

  it("card_rulings with an id skips the name-resolution request", async () => {
    const fetchMock = mockFetch({ object: "list", data: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({
      name: "card_rulings",
      arguments: { id: "abc-123" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/cards/abc-123/rulings");
    // empty data is a real answer (no rulings), not an error
    expect(bodyOf(res).data).toEqual([]);
  });

  it("card_rulings rejects when given neither a name nor an id", async () => {
    vi.stubGlobal("fetch", mockFetch({ object: "list", data: [] }));
    const client = await connect();
    await expect(
      client.callTool({ name: "card_rulings", arguments: {} }),
    ).rejects.toThrow(/needs a name or a Scryfall id/);
  });

  it("card_rulings surfaces an unknown name as an error, not as empty rulings", async () => {
    // Otherwise a typo'd card reads as "this card has no rulings".
    vi.stubGlobal(
      "fetch",
      mockFetch({ object: "error", status: 404, details: "No card found." }, 404),
    );
    const client = await connect();
    await expect(
      client.callTool({ name: "card_rulings", arguments: { name: "Nonexistent Card" } }),
    ).rejects.toThrow(/No card found/);
  });

  it("a hung request is bounded by the abort signal and does not deadlock later calls", async () => {
    // Repro of the pre-fix deadlock: the serialized queue meant one never-resolving
    // fetch blocked every later tool call for the process lifetime. The fix passes
    // AbortSignal.timeout to fetch, so a stuck request aborts and the queue recovers.
    // This mock only settles when a signal is wired (models the timeout firing) and
    // never settles otherwise (models the old, signal-less hang).
    const hungUntilAbort = vi.fn((_url: any, opts: any = {}) =>
      new Promise((_resolve, reject) => {
        if (opts.signal instanceof AbortSignal) {
          setTimeout(
            () => reject(new DOMException("The operation timed out.", "TimeoutError")),
            10,
          );
        }
        // no signal: never settles (the bug)
      }),
    );
    vi.stubGlobal("fetch", hungUntilAbort);
    const client = await connect();
    await expect(
      client.callTool({ name: "card_random", arguments: {} }),
    ).rejects.toThrow();
    // The queue must recover: a later call with a healthy fetch still completes.
    vi.stubGlobal("fetch", mockFetch({ object: "card", name: "Island" }));
    const res = await client.callTool({ name: "card_named", arguments: { name: "Island" } });
    expect(bodyOf(res).name).toBe("Island");
  });

  it("serializes concurrent tool calls through the rate-limit queue", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return new Response(JSON.stringify({ object: "card", name: "X" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const client = await connect();
    await Promise.all([
      client.callTool({ name: "card_random", arguments: {} }),
      client.callTool({ name: "card_random", arguments: {} }),
      client.callTool({ name: "card_random", arguments: {} }),
    ]);
    expect(maxConcurrent).toBe(1);
  });
});
