// MCP security audit 2026-11-25 (lower-severity): a failed call came back as a JSON-RPC error,
// which some clients never show the model, and card_collection took any number of identifiers
// (each 75 a rate-limited POST). Now a failed call is a tool result with isError and the reason
// as text, and one call takes at most COLLECTION_CALL_MAX identifiers. An unknown tool stays a
// protocol error, as the MCP spec says.
import { afterEach, describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, clearScryfallCache, UNTRUSTED_LABEL, COLLECTION_CALL_MAX } from "../server.js";

afterEach(() => vi.unstubAllGlobals());

type Result = { isError?: boolean; content: { type: string; text: string }[] };

async function connected() {
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("tool errors and the identifier cap", () => {
  it("a bad argument is a tool result with isError, the reason after the label", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = await connected();
    const r = (await client.callTool({ name: "card_named", arguments: {} })) as Result;
    await client.close();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(UNTRUSTED_LABEL);
    expect(r.content[1].text).toMatch(/card_named requires a non-empty name/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an upstream failure is a tool result with isError carrying Scryfall's details", async () => {
    clearScryfallCache();
    const body = { object: "error", status: 404, code: "not_found", details: "No cards found matching “Nope”" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 404, headers: { "content-type": "application/json" } })));
    const client = await connected();
    const r = (await client.callTool({ name: "card_named", arguments: { name: "Nope" } })) as Result;
    await client.close();
    expect(r.isError).toBe(true);
    expect(r.content[1].text).toMatch(/No cards found/);
  });

  it("card_collection refuses more than COLLECTION_CALL_MAX identifiers before any request", async () => {
    expect(COLLECTION_CALL_MAX).toBeGreaterThanOrEqual(600); // a large cube in one call
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const client = await connected();
    const identifiers = Array.from({ length: COLLECTION_CALL_MAX + 1 }, (_, i) => `Card ${i}`);
    const r = (await client.callTool({ name: "card_collection", arguments: { identifiers } })) as Result;
    await client.close();
    expect(r.isError).toBe(true);
    expect(r.content[1].text).toMatch(new RegExp(`at most ${COLLECTION_CALL_MAX}`));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("an unknown tool is still a protocol error", async () => {
    const client = await connected();
    await expect(client.callTool({ name: "no_such_tool", arguments: {} })).rejects.toThrow(/Unknown tool/);
    await client.close();
  });
});
