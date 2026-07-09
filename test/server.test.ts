import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server";

async function connect(): Promise<Client> {
  const server = createServer();
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function mockFetch(payload: unknown, status = 200) {
  return vi.fn(async () =>
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
});
