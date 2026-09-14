import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, clearScryfallCache } from "../server.js";

/**
 * The retry layer's only observable effect is a delay, and a delay is invisible
 * to an assertion on the returned value: a honoured Retry-After and an ignored
 * one both just... wait. These tests drive a fake clock and read the gaps
 * between fetch calls, so "honoured" and "ignored" are distinguishable.
 *
 * ⚠️ They live in their own FILE on purpose. Advancing a fake clock by N ms
 * leaves the rate limiter's `lastCall` N ms in the future; a later test on a
 * restored real clock then reads that gap as "not enough time has passed" and
 * waits it out for real. Vitest isolates module state per test file, so keeping
 * every fake-clock test here keeps that poisoning inside this file — where
 * startClock() jumps past it deliberately.
 *
 * Retries run INSIDE the rate-limited queue, so the gap between two attempts of
 * one call is the backoff alone, with no 100 ms pacing mixed in.
 */

async function connect(): Promise<Client> {
  const server = createServer();
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function res(body: unknown, status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const DOWN = { object: "error", status: 503, details: "upstream down" };

/**
 * Install the fake clock ten minutes ahead of wherever it is now, so the rate
 * limiter sees plenty of elapsed time and adds no pacing wait of its own — no
 * matter how far a previous test in this file advanced it.
 */
function startClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 10 * 60_000);
}

/** Past every backoff in this file, and under the MCP client's 60 s request
 *  timeout, which sits on this same fake clock. */
const RUN_MS = 20_000;

beforeEach(() => clearScryfallCache());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Fail once with the given response headers, succeed on the retry, and return the
 * gap between the two attempts -- which is the wait the retry layer chose.
 */
async function gapAcrossOneRetry(
  client: Client,
  cardName: string,
  headers: Record<string, string>,
): Promise<number> {
  const at: number[] = [];
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      at.push(Date.now());
      return ++n === 1
        ? res({ object: "error", status: 429, details: "slow down" }, 429, headers)
        : res({ object: "card", name: cardName }, 200);
    }),
  );
  const call = client.callTool({ name: "card_named", arguments: { name: cardName } });
  await vi.advanceTimersByTimeAsync(RUN_MS);
  await call;
  expect(at).toHaveLength(2);
  return at[1] - at[0];
}

describe("Retry-After", () => {
  // Before these, exactly one test sent the header at all -- with a value of "0",
  // asserting only the call count and the card name. Both hold identically whether
  // the header is honoured or ignored, because ignoring it just means waiting the
  // 250 ms backoff and nothing measured the gap: retryAfterMs could have been
  // replaced by `return null` with the whole suite still green.

  it("waits the number of seconds the header asks for", async () => {
    const client = await connect();
    startClock();
    expect(await gapAcrossOneRetry(client, "Card R2", { "retry-after": "2" })).toBe(2000);
  });

  it("caps an outsized Retry-After at 10 s", async () => {
    // Scryfall's own 429 body says 60 s. Honouring an arbitrary upstream number
    // would wedge the serialized queue for that long, so the header is advice with
    // a ceiling, not an instruction.
    const client = await connect();
    startClock();
    expect(await gapAcrossOneRetry(client, "Card R9999", { "retry-after": "9999" })).toBe(10_000);
  });

  it("ignores the HTTP-date form and falls back to the backoff", async () => {
    // Retry-After is seconds or an HTTP date. Only the numeric form is parsed;
    // Number() of a date string is NaN, and a NaN wait is not a wait at all.
    const client = await connect();
    startClock();
    expect(
      await gapAcrossOneRetry(client, "Card RDate", {
        "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT",
      }),
    ).toBe(250);
  });
});

describe("retry timing", () => {
  it("does not carry a Retry-After past the attempt cap into the next call", async () => {
    // pendingRetryAfter is module-global: attemptOnce sets it before throwing and
    // attemptWithRetry consumes it on the next backoff. When the LAST attempt set
    // it, the loop exited with the value still there and an unrelated later call
    // spent it -- up to the 10 s ceiling -- instead of its own 250 ms step.
    const client = await connect();
    const at: number[] = [];
    startClock();

    // A: every attempt 503s with retry-after: 5, exhausting the cap.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        at.push(Date.now());
        return res(DOWN, 503, { "retry-after": "5" });
      }),
    );
    const a = client.callTool({ name: "card_named", arguments: { name: "Card A" } });
    const aRejects = expect(a).rejects.toThrow(/upstream down/);
    await vi.advanceTimersByTimeAsync(RUN_MS);
    await aRejects;
    expect(at).toHaveLength(3);
    expect(at[1] - at[0]).toBe(5000); // honoured inside its own call

    // B: a different card, failing once at the NETWORK layer then succeeding.
    // That path is what makes the leak reachable: an HTTP 429/5xx re-assigns
    // pendingRetryAfter on its way out (to null when the response carries no
    // header), but a dropped connection or an abort throws RetryableError
    // without touching it -- so B's first backoff reads whatever A left behind.
    // It must be the 250 ms step, not A's 5 s.
    at.length = 0;
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        at.push(Date.now());
        if (++n === 1) throw new TypeError("fetch failed");
        return res({ object: "card", name: "Card B" }, 200);
      }),
    );
    const b = client.callTool({ name: "card_named", arguments: { name: "Card B" } });
    await vi.advanceTimersByTimeAsync(RUN_MS);
    await b;
    expect(at).toHaveLength(2);
    expect(at[1] - at[0]).toBe(250);
  });
});
