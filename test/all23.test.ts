import { afterEach, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

let client: Client;
const secret = "sk-PLANTED-0000-not-a-real-key";

async function start(env: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubEnv("PLANTED_SECRET", secret); // Scryfall reads no API key.
  vi.stubEnv("SCRYFALL_CONTACT", "");
  vi.stubEnv("SCRYFALL_MAX_ATTEMPTS", "3");
  vi.stubEnv("SCRYFALL_CACHE_TTL_MS", "0");
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const stderr: string[] = [];
  // Vitest replaces console's stream, so capture that route as well as direct writes.
  vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    stderr.push(parts.map(String).join(" "));
  });
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  const [server, sdk, memory] = await Promise.all([
    import("../server.js"),
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
  ]);
  client = new sdk.Client({ name: "all23", version: "1" }, { capabilities: {} });
  const [a, b] = memory.InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.createServer().connect(b)]);
  vi.useFakeTimers();
  return stderr;
}

function response(body: unknown, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const pending = client.callTool({ name, arguments: args });
  await vi.advanceTimersByTimeAsync(30_000);
  return pending;
}

afterEach(async () => {
  await client?.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const families: [string, Record<string, unknown>][] = [
  ["card_named", { name: "Example" }],
  ["card_fuzzy", { name: "Example" }],
  ["card_search", { q: "t:land" }],
  ["card_collection", { identifiers: ["Example"] }],
  ["card_random", {}],
  ["card_rulings", { id: "example" }],
  ["bulk_default", {}],
];

it.each(families)("ALL-2 %s keeps planted env out of results, protocol errors and stderr", async (name, args) => {
  // Exercise startup stderr too, rather than passing solely on an empty log.
  const stderr = await start({ SCRYFALL_CONTACT: "x".repeat(257) });
  const fetchMock = vi.fn(async () => response({ object: "card", name: "Example", data: [], not_found: [] }));
  vi.stubGlobal("fetch", fetchMock);
  const ok = await call(name, args);
  expect(ok.isError).not.toBe(true);
  expect(fetchMock).toHaveBeenCalled();
  expect(JSON.stringify(ok)).not.toContain(secret); // Includes all content and structuredContent.
  fetchMock.mockImplementation(async () => response({ details: "fixture miss" }, 404));
  const failed = await call(name, args);
  expect(failed.isError).toBe(true);
  expect(JSON.stringify(failed)).toContain("fixture miss");
  expect(JSON.stringify(failed)).not.toContain(secret);
  // Unknown tools use the protocol error channel, unlike upstream failures.
  const protocol = await client.callTool({ name: "all23_unknown", arguments: {} }).then(
    () => { throw new Error("expected a protocol error"); },
    (error: Error & { code?: number; data?: unknown }) => error,
  );
  expect(protocol.message).toContain("Unknown tool");
  expect(JSON.stringify({ ...protocol, message: protocol.message })).not.toContain(secret);
  expect(stderr.join("")).toContain("ignoring SCRYFALL_CONTACT");
  expect(stderr.join("")).not.toContain(secret);
});

it("ALL-3 collection accepts 1000 and refuses 1001 before fetch", async () => {
  await start();
  const fetchMock = vi.fn(async () => response({ data: [], not_found: [] }));
  vi.stubGlobal("fetch", fetchMock);
  const identifiers = Array.from({ length: 1000 }, (_, i) => `Card ${i}`);
  expect((await call("card_collection", { identifiers })).isError).not.toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(14);
  fetchMock.mockClear();
  const refused = await call("card_collection", { identifiers: [...identifiers, "Extra"] });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused)).toContain("at most 1000");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("ALL-3 POST chunks accept 75 and split 76 without an oversized fetch", async () => {
  await start();
  const sizes: number[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    sizes.push(JSON.parse(String(init.body)).identifiers.length);
    return response({ data: [], not_found: [] });
  }));
  for (const count of [75, 76]) {
    expect((await call("card_collection", { identifiers: Array(count).fill("Example") })).isError).not.toBe(true);
  }
  expect(sizes).toEqual([75, 75, 1]);
});

it("ALL-3 contact accepts 256 and rejects 257 before fetch", async () => {
  for (const length of [256, 257]) {
    const stderr = await start({ SCRYFALL_CONTACT: "x".repeat(length) });
    expect(stderr.join("").includes("ignoring SCRYFALL_CONTACT")).toBe(length === 257);
    const fetchMock = vi.fn(async (_url: unknown, _init: RequestInit) => response({ name: "Example" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
    await call("card_random");
    const ua = (fetchMock.mock.calls[0][1].headers as Record<string, string>)["User-Agent"];
    expect(ua).toContain(length === 256 ? "x".repeat(256) : "github.com/haksanlulz/mcp-scryfall");
    await client.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

it("ALL-3 attempt configuration accepts 10 and rejects 11 before fetch", async () => {
  for (const attempts of [10, 11]) {
    const stderr = await start({ SCRYFALL_MAX_ATTEMPTS: String(attempts) });
    expect(stderr.join("").includes("ignoring SCRYFALL_MAX_ATTEMPTS")).toBe(attempts === 11);
    const fetchMock = vi.fn(async () => response({ details: "down" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await call("card_random")).isError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(attempts === 10 ? 10 : 3);
    await client.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

it("ALL-3 Retry-After accepts 10000 ms and clamps 10001 ms", async () => {
  await start();
  for (const seconds of [10, 10.001]) {
    const at: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => {
      at.push(Date.now());
      return at.length === 1
        ? response({ details: "slow down" }, 429, { "retry-after": String(seconds) })
        : response({ name: "Example" });
    }));
    expect((await call("card_random")).isError).not.toBe(true);
    expect(at).toHaveLength(2);
    expect(at[1] - at[0]).toBe(10_000);
  }
});

it("ALL-3 fetch installs a 15000 ms deadline", async () => {
  await start();
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
    expect(init.signal).toBe(controller.signal);
    return response({ name: "Example" });
  });
  vi.stubGlobal("fetch", fetchMock);
  expect((await call("card_random")).isError).not.toBe(true);
  expect(timeout).toHaveBeenCalledWith(15_000);
});

it("ALL-3 printing lookup walks one page even when upstream advertises another", async () => {
  await start();
  const fetchMock = vi.fn(async (url: unknown) => String(url).includes("/cards/named")
    ? response({ object: "card", name: "Example", oracle_id: "example" })
    : response({ data: Array(175).fill({ set: "abc" }), total_cards: 176, has_more: true,
      next_page: "https://api.scryfall.com/cards/search?page=2" }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await call("card_named", { name: "Example" });
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result)).toContain("printings_truncated");
  expect(fetchMock).toHaveBeenCalledTimes(2); // Card + one printing page, never next_page.
});

it("ALL-3 cache accepts its configured entry cap and evicts on cap plus one", async () => {
  await start({ SCRYFALL_CACHE_MAX: "2", SCRYFALL_CACHE_TTL_MS: "86400000" });
  const fetchMock = vi.fn(async () => response({ name: "Example" }));
  vi.stubGlobal("fetch", fetchMock);
  for (const name of ["A", "B", "B"]) await call("card_named", { name });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await call("card_named", { name: "C" });
  await call("card_named", { name: "B" });
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await call("card_named", { name: "A" });
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it("ALL-3 cache serves at TTL and expires at TTL plus one millisecond", async () => {
  await start({ SCRYFALL_CACHE_TTL_MS: "86400000" });
  let fetchedAt = 0;
  const fetchMock = vi.fn(async () => {
    fetchedAt = Date.now();
    return response({ name: "Example" });
  });
  vi.stubGlobal("fetch", fetchMock);
  await call("card_named", { name: "Example" });
  const born = fetchedAt;
  vi.setSystemTime(born + 86_400_000);
  await call("card_named", { name: "Example" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  vi.setSystemTime(born + 86_400_001);
  await call("card_named", { name: "Example" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
