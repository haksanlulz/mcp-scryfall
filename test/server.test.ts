import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, clearScryfallCache } from "../server.js";

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

// The response cache lives for the process, so a value cached by one test would be
// served to the next and make the suite order-dependent. Reset before every test.
beforeEach(() => clearScryfallCache());

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
        data: [{ name: "Ash Zealot", oracle_text: "First strike, haste", rarity: "rare" }],
      }),
    );
    const client = await connect();
    const res = await client.callTool({
      name: "card_search",
      arguments: { q: "t:goblin", full: true },
    });
    const body = bodyOf(res);
    expect(body.data[0].oracle_text).toBe("First strike, haste");
    // oracle_text alone did not tell the two apart -- summaries carry it too. The
    // raw response keeps Scryfall's own `object` key and the fields summarizeCard
    // drops, and the summary envelope has neither.
    expect(body.object).toBe("list");
    expect(body.data[0].rarity).toBe("rare");
  });

  // `full` is declared boolean, but inputSchema is advisory to this SDK's low-level
  // Server, so a client that serializes booleans as text sends "false" -- truthy --
  // and used to get the whole raw response back on a broad search.
  it('card_search reads full:"false" as false, not as a truthy string', async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        object: "list",
        total_cards: 1,
        has_more: false,
        data: [{ name: "Ash Zealot", oracle_text: "First strike, haste", rarity: "rare" }],
      }),
    );
    const client = await connect();
    const res = await client.callTool({
      name: "card_search",
      arguments: { q: "t:goblin", full: "false" },
    });
    const body = bodyOf(res);
    // the envelope, not Scryfall's own response: `page` is this server's field, and
    // `rarity` is a raw-card field summarizeCard drops
    expect(body.page).toBe(1);
    expect(body.data[0].name).toBe("Ash Zealot");
    expect(body.data[0].rarity).toBeUndefined();
  });

  it("card_search rejects a non-boolean full before any request", async () => {
    const fetchMock = mockFetch({ object: "list", total_cards: 0, data: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    await expect(
      client.callTool({ name: "card_search", arguments: { q: "t:goblin", full: "yes" } }),
    ).rejects.toThrow(/card_search requires full to be a boolean/);
    expect(fetchMock).not.toHaveBeenCalled();
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

  // The echoed page is a claim about the provenance of the rows beside it, so
  // these assert the outgoing URL and the envelope together -- either one alone
  // passed while the two disagreed.
  it("card_search sends and echoes the same page when none is given", async () => {
    const fetchMock = mockFetch({ object: "list", total_cards: 1, has_more: false, data: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({ name: "card_search", arguments: { q: "t:goblin" } });
    expect(String(fetchMock.mock.calls[0][0])).toContain("&page=1");
    expect(bodyOf(res).page).toBe(1);
  });

  it("card_search sends and echoes the same page when one is given", async () => {
    const fetchMock = mockFetch({ object: "list", total_cards: 500, has_more: true, data: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({
      name: "card_search",
      arguments: { q: "t:goblin", page: 3 },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("&page=3");
    expect(bodyOf(res).page).toBe(3);
  });

  it("card_search rejects page 0 instead of echoing a page it did not request", async () => {
    // 0 was falsy, so no page parameter was sent and Scryfall served page 1 --
    // under an envelope claiming page 0.
    const fetchMock = mockFetch({ object: "list", total_cards: 1, has_more: false, data: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    await expect(
      client.callTool({ name: "card_search", arguments: { q: "t:goblin", page: 0 } }),
    ).rejects.toThrow(/page must be an integer >= 1/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("card_search rejects a non-numeric page instead of sending &page=NaN", async () => {
    // "abc" sent &page=NaN (Scryfall ignores it and serves page 1) while the echo
    // rendered Number("abc") as null.
    const fetchMock = mockFetch({ object: "list", total_cards: 1, has_more: false, data: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    await expect(
      client.callTool({ name: "card_search", arguments: { q: "t:goblin", page: "abc" } }),
    ).rejects.toThrow(/page must be an integer >= 1/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("card_search rejects a one-element array page instead of unwrapping it", async () => {
    // String(["2"]) is "2", so a list of pages silently became one page and the
    // envelope echoed it as if the caller had asked for it. `page` is declared
    // number; an array is the caller's mistake, the same as a non-string `order`.
    const fetchMock = mockFetch({ object: "list", total_cards: 1, has_more: false, data: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    await expect(
      client.callTool({ name: "card_search", arguments: { q: "t:goblin", page: ["2"] } }),
    ).rejects.toThrow(/page must be an integer >= 1/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("card_search surfaces a zero-result query as an error, not an empty list", async () => {
    // Scryfall answers a search matching nothing with HTTP 404 and an object:"error"
    // body (verified live: /cards/search?q=t%3Azzzznotatype). scryfallRequest throws
    // on any non-ok status, so that body never reaches the summarizer -- there is no
    // total_cards: 0 shape to return, and the tool description says so.
    vi.stubGlobal(
      "fetch",
      mockFetch(
        {
          object: "error",
          code: "not_found",
          status: 404,
          details:
            "Your query didn’t match any cards. Adjust your search terms or refer to the syntax guide at https://scryfall.com/docs/reference",
        },
        404,
      ),
    );
    const client = await connect();
    await expect(
      client.callTool({ name: "card_search", arguments: { q: "t:zzzznotatype" } }),
    ).rejects.toThrow(/match any cards/);
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
          jsonl_download_uri: "https://data.scryfall.io/oracle-cards/oracle.jsonl.gz",
          compressed_size: 24529261,
          updated_at: "2026-08-15T09:01:55.591Z",
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({ name: "bulk_default", arguments: {} });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/bulk-data");
    const body = bodyOf(res);
    expect(body.data[0].type).toBe("oracle_cards");
    expect(body.data[0].jsonl_download_uri).toContain("scryfall.io");
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

  it('card_collection reads full:"true" as true, not as a string', async () => {
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
      arguments: { identifiers: ["Lightning Bolt"], full: "true" },
    });
    // legalities is a raw-object field; summarizeCard reduces it to legal_commander
    expect(bodyOf(res).data[0].legalities).toEqual({ modern: "legal" });
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

  // The low-level Server class does not validate arguments against inputSchema,
  // so `required` in the tool schema is advisory to the client. A missing name
  // used to reach String(undefined) and spend a real request looking up a card
  // called "undefined", handing the model Scryfall's problem instead of its own.
  // Same guarantee card_collection already had, one tool per case.
  it("card_named rejects a missing name before any request", async () => {
    const fetchMock = mockFetch({ object: "card", name: "X" });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    await expect(
      client.callTool({ name: "card_named", arguments: {} }),
    ).rejects.toThrow(/card_named requires a non-empty name/);
    await expect(
      client.callTool({ name: "card_named", arguments: { name: "   " } }),
    ).rejects.toThrow(/card_named requires a non-empty name/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("card_fuzzy rejects a missing name before any request", async () => {
    const fetchMock = mockFetch({ object: "card", name: "X" });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    await expect(
      client.callTool({ name: "card_fuzzy", arguments: {} }),
    ).rejects.toThrow(/card_fuzzy requires a non-empty name/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("card_search rejects a missing q before any request", async () => {
    const fetchMock = mockFetch({ object: "list", total_cards: 0, data: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    await expect(
      client.callTool({ name: "card_search", arguments: {} }),
    ).rejects.toThrow(/card_search requires a non-empty q/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The optional arguments had the same hole the required ones did: truthy-tested,
  // then String()-coerced, so a non-string reached the URL as "[object Object]" or
  // a comma-joined list and bought a request for a filter nobody meant. One case
  // per argument, each asserting the request was never issued.
  it.each([
    ["card_named", { name: "Black Lotus", set: {} }, /card_named requires set/],
    ["card_named", { name: "Black Lotus", set: 3 }, /card_named requires set/],
    ["card_search", { q: "t:goblin", order: ["cmc"] }, /card_search requires order/],
    ["card_random", { q: ["t:goblin"] }, /card_random requires q/],
    ["card_rulings", { id: {} }, /card_rulings requires id/],
    ["card_rulings", { name: 42 }, /card_rulings requires name/],
  ])("%s rejects a non-string optional argument before any request", async (tool, args, msg) => {
    const fetchMock = mockFetch({ object: "card", name: "X", id: "abc" });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    await expect(client.callTool({ name: tool, arguments: args })).rejects.toThrow(msg);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The other half of that validation, and the half rejecting a blank got wrong:
  // a client that fills every declared property sends "" for the ones it has no
  // value for. That is "absent", not a bad argument -- it was ignored before the
  // validation existed, and these pin that it still is.
  it("treats a blank optional set as absent rather than as an error", async () => {
    const fetchMock = mockFetch({ object: "card", name: "Sol Ring" });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({
      name: "card_named",
      arguments: { name: "Sol Ring", set: "" },
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/cards/named?exact=Sol%20Ring");
    expect(url).not.toContain("&set=");
    expect(bodyOf(res).name).toBe("Sol Ring");
  });

  it("falls through to the name when card_rulings is given a blank id", async () => {
    // {id: "", name: "..."} is the shape that regressed hardest: a blank id used
    // to fall through to name resolution, then started throwing instead.
    const fetchMock = vi
      .fn(async (_url?: any, _init?: any) => new Response("{}"))
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify({ object: "card", name: "Sol Ring", id: "sol-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      )
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify({ object: "list", data: [{ comment: "a ruling" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({
      name: "card_rulings",
      arguments: { id: "", name: "Sol Ring" },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/cards/named?exact=Sol%20Ring");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/cards/sol-1/rulings");
    expect(bodyOf(res).data[0].comment).toBe("a ruling");
  });

  // Blank-means-absent reached only the STRING helper. A client that fills every
  // declared property does not consult the declared type before blanking the ones
  // it has no value for, so the number and boolean fields get "" too -- and both
  // rejected it, failing a call whose argument was meaningfully omitted.
  it("treats a blank page as page 1, in the URL and in the echo together", async () => {
    const fetchMock = mockFetch({ object: "list", total_cards: 1, has_more: false, data: [] });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({
      name: "card_search",
      arguments: { q: "t:goblin", page: "" },
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("&page=1");
    expect(bodyOf(res).page).toBe(1);
  });

  it("treats a blank full on card_search as false, so summaries still come back", async () => {
    const fetchMock = mockFetch({
      object: "list",
      total_cards: 1,
      has_more: false,
      data: [{ object: "card", name: "Goblin Guide", mana_cost: "{R}" }],
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({
      name: "card_search",
      arguments: { q: "t:goblin", full: "" },
    });
    const body = bodyOf(res);
    // the summary envelope, not the raw Scryfall list full:true would have returned
    expect(body.total_cards).toBe(1);
    expect(body.data[0].name).toBe("Goblin Guide");
    expect(body.data[0].object).toBeUndefined();
  });

  it("treats a blank full on card_collection as false", async () => {
    const fetchMock = mockFetch({
      object: "list",
      data: [{ object: "card", name: "Sol Ring", mana_cost: "{1}" }],
      not_found: [],
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const res = await client.callTool({
      name: "card_collection",
      arguments: { identifiers: ["Sol Ring"], full: "" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = bodyOf(res);
    expect(body.found).toBe(1);
    // summarized, not the raw card object full:true would have returned
    expect(body.data[0].name).toBe("Sol Ring");
    expect(body.data[0].object).toBeUndefined();
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

describe("response cache", () => {
  // Scryfall asks clients to cache. These pin the three properties that make a
  // cache safe rather than merely fast: it must hit, it must not swallow the one
  // endpoint whose whole value is being different each time, and it must never
  // serve an error back as though it were data.

  it("serves a repeated lookup without a second request", async () => {
    const fetchMock = mockFetch({ object: "card", name: "Black Lotus" });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    const a = await client.callTool({ name: "card_named", arguments: { name: "Black Lotus" } });
    const b = await client.callTool({ name: "card_named", arguments: { name: "Black Lotus" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(b as any)).toEqual(bodyOf(a as any));
  });

  it("never caches card_random", async () => {
    const fetchMock = mockFetch({ object: "card", name: "Whatever" });
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();
    await client.callTool({ name: "card_random", arguments: {} });
    await client.callTool({ name: "card_random", arguments: {} });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache an error response", async () => {
    const fail = mockFetch({ object: "error", status: 404, details: "no card" }, 404);
    vi.stubGlobal("fetch", fail);
    const client = await connect();
    await expect(client.callTool({ name: "card_named", arguments: { name: "Nope" } })).rejects.toThrow();
    await expect(client.callTool({ name: "card_named", arguments: { name: "Nope" } })).rejects.toThrow();
    // a cached 404 would leave this at 1 and pin the failure for the whole process
    expect(fail).toHaveBeenCalledTimes(2);
  });
});

describe("transient-failure retry", () => {
  // Scryfall asks clients to back off on 429. These pin what must and must not
  // be retried: repeating a 404 spends the rate limit to re-learn an answer we
  // already have.
  it("retries a 429 and succeeds on the next attempt", async () => {
    let n = 0;
    const flaky = vi.fn(async () => {
      n++;
      return n === 1
        ? new Response(JSON.stringify({ object: "error", status: 429, details: "slow down" }),
            { status: 429, headers: { "content-type": "application/json", "retry-after": "0" } })
        : new Response(JSON.stringify({ object: "card", name: "Lightning Bolt" }),
            { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", flaky);
    const client = await connect();
    const res = await client.callTool({ name: "card_named", arguments: { name: "Lightning Bolt" } });
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(bodyOf(res as any).name).toBe("Lightning Bolt");
  });

  it("does NOT retry a 404", async () => {
    const miss = mockFetch({ object: "error", status: 404, details: "no card" }, 404);
    vi.stubGlobal("fetch", miss);
    const client = await connect();
    await expect(client.callTool({ name: "card_named", arguments: { name: "Nope" } })).rejects.toThrow();
    expect(miss).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt cap and surfaces Scryfall's own message", async () => {
    const down = mockFetch({ object: "error", status: 503, details: "upstream unavailable" }, 503);
    vi.stubGlobal("fetch", down);
    const client = await connect();
    await expect(client.callTool({ name: "card_named", arguments: { name: "X" } }))
      .rejects.toThrow(/upstream unavailable/);
    expect(down).toHaveBeenCalledTimes(3);
  });

  // Every abort case above rejects AT fetch(). A request is not over when its
  // headers arrive: the 15 s timeout can fire while the body is still streaming,
  // and a connection can drop mid-body. Both reject at res.text() instead, one
  // line past the catch that classifies a failure as retryable -- so the same
  // failure got one attempt here and three a moment earlier. The call count is
  // the whole assertion: it is what tells retried from not-retried.
  it("retries a body that dies mid-read, not just a fetch that never connected", async () => {
    const dyingBody = vi.fn(async () => {
      const res = new Response("", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
      Object.defineProperty(res, "text", {
        value: async () => {
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        },
      });
      return res;
    });
    vi.stubGlobal("fetch", dyingBody);
    const client = await connect();
    await expect(
      client.callTool({ name: "card_named", arguments: { name: "X" } }),
    ).rejects.toThrow(/aborted due to timeout/);
    expect(dyingBody).toHaveBeenCalledTimes(3);
  });

  it("recovers when only the FIRST body read dies", async () => {
    // The other half: retrying is only worth doing if the retry can succeed.
    const flaky = vi
      .fn(async () =>
        new Response(JSON.stringify({ object: "card", name: "Sol Ring" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockImplementationOnce(async () => {
        const res = new Response("", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
        Object.defineProperty(res, "text", {
          value: async () => {
            throw new TypeError("terminated");
          },
        });
        return res;
      });
    vi.stubGlobal("fetch", flaky);
    const client = await connect();
    const res = await client.callTool({
      name: "card_named",
      arguments: { name: "Sol Ring" },
    });
    expect(bodyOf(res).name).toBe("Sol Ring");
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});
