import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

/**
 * The .mcpb bundle is a SECOND shipping path beside the tsx one: the manifest
 * points at emitted JavaScript that a host runs with `node`, while every other
 * rung in this repo drives the TypeScript. Two paths for one server is the class
 * GAUNTLET §6 is a log of, so the parts of the manifest that can silently
 * disagree with the code are pinned here, in the offline gate that always runs.
 *
 * What this canNOT check: whether an MCPB host's install dialog actually maps the
 * user_config field into the environment. That is host behavior. `npm run bundle`
 * packs, validates against the 0.3 schema, unpacks and drives the packed entry
 * point over stdio; the dialog itself is exercised only by a real install.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

async function connect(): Promise<Client> {
  const server = createServer();
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("mcpb manifest", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("declares manifest version 0.3 and matches package.json's identity", () => {
    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.name).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.license).toBe(pkg.license);
  });

  it("introduces itself, and identifies itself to Scryfall, as that same version", async () => {
    // The version is one fact with four owners: package.json, manifest.json, the
    // serverInfo literal in server.ts and the User-Agent's product token. The case
    // above ties the first two together and nothing tied the last two to anything,
    // so a bump touching the two JSON files passed the whole gate while the server
    // announced the old version on the wire and to the API it is a client of.
    const fetchMock = vi.fn(async (_url?: any, _init?: any) =>
      new Response(JSON.stringify({ object: "card", name: "Black Lotus" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = await connect();

    expect(client.getServerVersion()).toMatchObject({
      name: pkg.name,
      version: pkg.version,
    });

    await client.callTool({ name: "card_named", arguments: { name: "Black Lotus" } });
    const ua = (fetchMock.mock.calls[0][1] as any).headers["User-Agent"];
    // Scryfall's guidelines ask for a descriptive User-Agent, and the convention
    // there is a major.minor product token rather than the full patch version.
    const [major, minor] = pkg.version.split(".");
    expect(ua).toMatch(new RegExp(`^${pkg.name}/${major}\\.${minor} \\(`));
  });

  it("points command, args and entry_point at the same built file", () => {
    // entry_point and args are two statements of one fact; a rename that touched
    // only one would pack cleanly and fail at launch.
    expect(manifest.server.type).toBe("node");
    expect(manifest.server.entry_point).toBe("dist/index.js");
    expect(manifest.server.mcp_config.command).toBe("node");
    expect(manifest.server.mcp_config.args).toEqual([
      `\${__dirname}/${manifest.server.entry_point}`,
    ]);
  });

  it("wires SCRYFALL_CONTACT to a declared, optional, non-sensitive user_config field", () => {
    const key = "scryfall_contact";
    expect(manifest.server.mcp_config.env.SCRYFALL_CONTACT).toBe(`\${user_config.${key}}`);
    const field = manifest.user_config?.[key];
    expect(field).toBeDefined();
    expect(field.type).toBe("string");
    // This server needs no API key. The contact is the courtesy address Scryfall's
    // guidelines ask for, so marking it sensitive would hide a value whose whole
    // purpose is to be sent, and requiring it would gate an install on nothing.
    expect(field.required).toBe(false);
    expect(field.sensitive).toBe(false);
  });

  it("names a privacy policy, because the bundle reaches an external service", () => {
    expect(Array.isArray(manifest.privacy_policies)).toBe(true);
    expect(manifest.privacy_policies.length).toBeGreaterThan(0);
    expect(manifest.privacy_policies[0]).toMatch(/^https:\/\/scryfall\.com\//);
  });

  it("lists exactly the tools the server serves", async () => {
    const client = await connect();
    const served = (await client.listTools()).tools.map((t) => t.name).sort();
    const declared = (manifest.tools ?? []).map((t: any) => t.name).sort();
    expect(declared).toEqual(served);
  });
});
