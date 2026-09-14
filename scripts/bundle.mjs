#!/usr/bin/env node
/**
 * Build the .mcpb bundle, then prove the thing that was built actually runs.
 *
 * The repo deliberately has no build step: it runs .ts through tsx. A bundle
 * cannot, because an MCPB host runs `node <entry_point>` with no toolchain of its
 * own, so `server.type: "node"` needs emitted JavaScript. That introduces a second
 * shipping path beside the tsx one, and two paths for one server is exactly the
 * class GAUNTLET §6 is a log of -- so packing and probing are one command, and the
 * probe drives the PACKED artifact over stdio rather than the source.
 *
 * Steps: clean -> tsc -> stage -> production-only install -> pack -> validate ->
 * unpack -> spawn the unpacked entry point and speak JSON-RPC to it.
 *
 * The probe is OFFLINE (initialize + tools/list only), so CI can run it without
 * touching Scryfall. The live round-trip through the built entry point is
 * `SMOKE_SERVER_PATH=<abs path to dist/index.js> npm run smoke`.
 *
 * Exit 0 = packed and probed. Any failure exits non-zero.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const STAGE = join(BUILD, "bundle");
const PROBE = join(BUILD, "probe");
const MCPB_VERSION = "2.1.2"; // pinned: an unpinned toolchain is a silent drift channel
const EXPECTED_TOOLS = [
  "bulk_default",
  "card_collection",
  "card_fuzzy",
  "card_named",
  "card_random",
  "card_rulings",
  "card_search",
];

function run(label, cmd, args, opts = {}) {
  console.log(`\n> ${label}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: true, ...opts });
  if (r.status !== 0) {
    console.error(`FAILED: ${label} (exit ${r.status})`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------- clean + build */

rmSync(BUILD, { recursive: true, force: true });
run("tsc -p tsconfig.build.json", "npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: ROOT });

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const entry = join(ROOT, manifest.server.entry_point);
if (!existsSync(entry)) {
  console.error(`FAILED: manifest entry_point ${manifest.server.entry_point} does not exist after the build`);
  process.exit(1);
}

/* ------------------------------------------------------------------- staging */

mkdirSync(STAGE, { recursive: true });
cpSync(join(ROOT, "dist"), join(STAGE, "dist"), { recursive: true });
for (const f of ["manifest.json", "package.json", "package-lock.json", "README.md", "LICENSE"]) {
  cpSync(join(ROOT, f), join(STAGE, f));
}

// index.ts carries `#!/usr/bin/env -S npx tsx` so the source is directly runnable
// in dev; tsc copies it verbatim. Node ignores a shebang when the file is passed
// to it, so this is cosmetic -- but a built file that says "run me through tsx" is
// a false statement about the artifact, and someone will eventually chmod +x it.
const staged = join(STAGE, "dist", "index.js");
const src = readFileSync(staged, "utf8");
writeFileSync(staged, src.replace(/^#!.*\n/, "#!/usr/bin/env node\n"));

// The host installs nothing: whatever the server imports at runtime has to be
// inside the bundle. `npm ci --omit=dev` off the repo's own lockfile keeps that
// reproducible and keeps tsx/vitest/typescript out.
run("npm ci --omit=dev (staging)", "npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: STAGE });

/* --------------------------------------------------------- validate and pack */

run("mcpb validate", "npx", ["-y", `@anthropic-ai/mcpb@${MCPB_VERSION}`, "validate", "manifest.json"], { cwd: STAGE });

const out = join(BUILD, `${manifest.name}-${manifest.version}.mcpb`);
run("mcpb pack", "npx", ["-y", `@anthropic-ai/mcpb@${MCPB_VERSION}`, "pack", STAGE, out]);
console.log(`\npacked: ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);

/* ------------------------------------------------- probe the packed artifact */

run("mcpb unpack", "npx", ["-y", `@anthropic-ai/mcpb@${MCPB_VERSION}`, "unpack", out, PROBE]);

const probeEntry = join(PROBE, manifest.server.entry_point);
if (!existsSync(probeEntry)) {
  console.error(`FAILED: ${manifest.server.entry_point} is not inside the packed bundle`);
  process.exit(1);
}

const child = spawn("node", [probeEntry], {
  stdio: ["pipe", "pipe", "pipe"],
  // The manifest maps the SCRYFALL_CONTACT user_config into this variable; pass one
  // so the probe exercises the same shape a host install produces.
  env: { ...process.env, SCRYFALL_CONTACT: "bundle-probe@example.invalid" },
});
let stderr = "";
child.stderr.on("data", (d) => { stderr += String(d); });

const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += String(d);
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch { /* not a JSON-RPC line */ }
  }
});

let nextId = 1;
function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((res_, rej) => {
    const timer = setTimeout(() => rej(new Error(`timeout waiting for ${method}`)), 30_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      msg.error ? rej(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : res_(msg.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

let failed = false;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "mcpb-bundle-probe", version: "1.0.0" },
  });
  check("bundle: initialize handshake", init?.serverInfo?.name === manifest.name,
    `serverInfo.name=${init?.serverInfo?.name}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);

  const list = await rpc("tools/list");
  const names = (list?.tools ?? []).map((t) => t.name).sort();
  check(`bundle: tools/list is exactly the ${EXPECTED_TOOLS.length} tools`,
    JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), names.join(", "));
} catch (e) {
  check(`bundle: probe error: ${e.message}`, false, stderr.slice(-400));
} finally {
  child.kill();
}

console.log(failed ? "\nBundle probe FAILED." : "\nBundle packed and probed.");
process.exit(failed ? 1 : 0);
