import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The three env knobs are read once at module load, so each case needs a fresh
 * module instance rather than a mutated global. vi.resetModules() plus a dynamic
 * import gives one; the SDK is re-imported alongside it so the client and the
 * server come from the same registry.
 *
 * A fresh instance also starts with an empty cache and `lastCall = 0`, so the
 * first request of each case skips the 100 ms pacing wait.
 */
async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  const [server, clientMod, memory] = await Promise.all([
    import("../server.js"),
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
  ]);
  const client = new clientMod.Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = memory.InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.createServer().connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, envInt: server.envInt };
}

function mockFetch(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return vi.fn(async (_url?: any, _init?: any) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  );
}

let logged: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // The rejection notice belongs on stderr in real use; here it would just be
  // noise in the reporter, so capture it and assert on it instead.
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("env knob parsing", () => {
  it("falls back to the documented default for a non-integer, zero or negative value", async () => {
    const { envInt } = await load({});
    for (const bad of ["abc", "-1", "0", "2.5", " ", ""]) {
      vi.stubEnv("SCRYFALL_CACHE_MAX", bad);
      expect(envInt("SCRYFALL_CACHE_MAX", 500, 1)).toBe(500);
    }
    // an empty or absent value is the unset case, not a rejected one: no notice
    expect(logged).toHaveBeenCalledTimes(4);
    expect(String(logged.mock.calls[0][0])).toMatch(/SCRYFALL_CACHE_MAX="abc".*using 500/);

    vi.stubEnv("SCRYFALL_CACHE_MAX", "12");
    expect(envInt("SCRYFALL_CACHE_MAX", 500, 1)).toBe(12);
  });

  it("keeps the cache on when SCRYFALL_CACHE_TTL_MS is unparseable", async () => {
    // NaN made `CACHE_TTL_MS > 0` false, turning the cache off with no log line.
    const fetchMock = mockFetch({ object: "card", name: "Black Lotus" });
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await load({ SCRYFALL_CACHE_TTL_MS: "abc" });
    await client.callTool({ name: "card_named", arguments: { name: "Black Lotus" } });
    await client.callTool({ name: "card_named", arguments: { name: "Black Lotus" } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats SCRYFALL_CACHE_TTL_MS=0 as the off switch, not as a bad value", async () => {
    // 0 is why the TTL floors at 0 and not at 1: `cacheable` reads it as "no cache".
    const fetchMock = mockFetch({ object: "card", name: "Black Lotus" });
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await load({ SCRYFALL_CACHE_TTL_MS: "0" });
    await client.callTool({ name: "card_named", arguments: { name: "Black Lotus" } });
    await client.callTool({ name: "card_named", arguments: { name: "Black Lotus" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logged).not.toHaveBeenCalled();
  });

  it("honours a finite SCRYFALL_CACHE_MAX by evicting the oldest entry", async () => {
    const fetchMock = mockFetch({ object: "card", name: "X" });
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await load({ SCRYFALL_CACHE_MAX: "2" });
    for (const name of ["A", "B", "C"]) {
      await client.callTool({ name: "card_named", arguments: { name } });
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // A was evicted when C landed, so it costs a request again; C is still cached.
    await client.callTool({ name: "card_named", arguments: { name: "A" } });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await client.callTool({ name: "card_named", arguments: { name: "C" } });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  for (const bad of ["abc", "0", "-1"]) {
    it(`still issues requests, and errors with a message, when SCRYFALL_MAX_ATTEMPTS=${bad}`, async () => {
      // `attempt < NaN` (and `attempt < 0`) is false on the first iteration, so
      // the loop issued no fetch at all and threw an undefined lastError: an
      // error with no message and no request behind it.
      const down = mockFetch(
        { object: "error", status: 503, details: "upstream unavailable" },
        503,
        { "retry-after": "0" }, // keep the backoff free; the cap is what is under test
      );
      vi.stubGlobal("fetch", down);
      const { client } = await load({ SCRYFALL_MAX_ATTEMPTS: bad });
      await expect(
        client.callTool({ name: "card_named", arguments: { name: "X" } }),
      ).rejects.toThrow(/upstream unavailable/);
      expect(down).toHaveBeenCalledTimes(3);
    });
  }

  // SCRYFALL_CONTACT is the one knob the .mcpb bundle exposes as a user_config
  // field, so these pin both ends of what that install produces.
  it("puts SCRYFALL_CONTACT into the User-Agent", async () => {
    const fetchMock = mockFetch({ object: "card", name: "Black Lotus" });
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await load({ SCRYFALL_CONTACT: "someone@example.invalid" });
    await client.callTool({ name: "card_named", arguments: { name: "Black Lotus" } });
    const ua = (fetchMock.mock.calls[0][1] as any).headers["User-Agent"];
    expect(ua).toMatch(/^mcp-scryfall\//);
    expect(ua).toContain("someone@example.invalid");
  });

  it("falls back to the repository URL when SCRYFALL_CONTACT is empty", async () => {
    // The bundle's user_config field is optional, so an install where the user
    // leaves it blank substitutes an empty string rather than omitting the
    // variable -- which is why the fallback in server.ts is `||` and not `??`.
    // Without it the User-Agent would end in "()" and identify nobody.
    const fetchMock = mockFetch({ object: "card", name: "Black Lotus" });
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await load({ SCRYFALL_CONTACT: "" });
    await client.callTool({ name: "card_named", arguments: { name: "Black Lotus" } });
    const ua = (fetchMock.mock.calls[0][1] as any).headers["User-Agent"];
    expect(ua).toContain("github.com/haksanlulz/mcp-scryfall");
  });

  it("rejects a SCRYFALL_MAX_ATTEMPTS above the ceiling instead of honouring it", async () => {
    // Bad only in magnitude: 3000 is a valid integer >= 1, so nothing rejected it.
    // Retries run inside the serialized queue, so honouring it would hold every
    // later tool call behind one wedged request. The README's table puts this row
    // directly under SCRYFALL_CACHE_TTL_MS=86400000, which is where a mistyped
    // value of this shape comes from.
    const down = mockFetch(
      { object: "error", status: 503, details: "upstream unavailable" },
      503,
      { "retry-after": "0" },
    );
    vi.stubGlobal("fetch", down);
    const { client, envInt } = await load({ SCRYFALL_MAX_ATTEMPTS: "3000" });
    await expect(
      client.callTool({ name: "card_named", arguments: { name: "X" } }),
    ).rejects.toThrow(/upstream unavailable/);
    expect(down).toHaveBeenCalledTimes(3);
    expect(String(logged.mock.calls[0][0])).toMatch(
      /SCRYFALL_MAX_ATTEMPTS="3000".*integer 1\.\.10.*using 3/,
    );
    // the ceiling is opt-in: a knob without one still takes any integer >= min
    vi.stubEnv("SCRYFALL_CACHE_MAX", "86400000");
    expect(envInt("SCRYFALL_CACHE_MAX", 500, 1)).toBe(86400000);
    expect(envInt("SCRYFALL_MAX_ATTEMPTS", 3, 1, 10)).toBe(3);
    expect(envInt("SCRYFALL_MAX_ATTEMPTS", 3, 1)).toBe(3000);
  });

  it("uses a valid SCRYFALL_MAX_ATTEMPTS as given", async () => {
    const down = mockFetch(
      { object: "error", status: 503, details: "upstream unavailable" },
      503,
      { "retry-after": "0" },
    );
    vi.stubGlobal("fetch", down);
    const { client } = await load({ SCRYFALL_MAX_ATTEMPTS: "1" });
    await expect(
      client.callTool({ name: "card_named", arguments: { name: "X" } }),
    ).rejects.toThrow(/upstream unavailable/);
    expect(down).toHaveBeenCalledTimes(1);
  });
});
