import { describe, expect, it } from "vitest";
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

describe("mcpb manifest", () => {
  it("declares manifest version 0.3 and matches package.json's identity", () => {
    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.name).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.license).toBe(pkg.license);
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
    const server = createServer();
    const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const served = (await client.listTools()).tools.map((t) => t.name).sort();
    const declared = (manifest.tools ?? []).map((t: any) => t.name).sort();
    expect(declared).toEqual(served);
  });
});
