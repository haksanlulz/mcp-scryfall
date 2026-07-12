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

  it("exposes all five tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "bulk_default",
      "card_fuzzy",
      "card_named",
      "card_random",
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
    expect(out.data[0]).toEqual({
      name: "Ash Zealot",
      mana_cost: "{R}{R}",
      type_line: "Creature — Goblin Berserker",
      cmc: 2,
      set: "rtr",
    });
    expect(out.data[0].oracle_text).toBeUndefined();
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

  it("card_search pulls mana_cost from card_faces for double-faced cards", async () => {
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
              { mana_cost: "{2}{R}{G}" },
              { mana_cost: "" },
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
    expect(bodyOf(res).data[0].mana_cost).toBe("{2}{R}{G}");
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
