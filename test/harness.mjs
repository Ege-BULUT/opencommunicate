// What the CLI and MCP tests share: the fake GitHub over HTTP with a seeded chat, a home (config folder) for each
// of its two devices, and the built CLI run as one of them. `npm run build -w cli` first.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Bus } from "../core/src/index.ts";
import { newIdentity, setUpKeys } from "../core/src/e2e.ts";
import { fakeGitHub, seeded, serve } from "./fakegh.mjs";

const CLI = path.join(import.meta.dirname, "..", "cli", "dist", "opencom.mjs");
const PRELOAD = path.join(import.meta.dirname, "preload.mjs");

export async function world() {
  const gh = fakeGitHub();
  const s = await seeded(gh, { Bus });
  const api = await serve(gh);
  const homes = {};
  for (const d of [s.ege, s.agent]) {
    homes[d.id] = fs.mkdtempSync(path.join(os.tmpdir(), `opencom-${d.nick}-`));
    fs.writeFileSync(path.join(homes[d.id], "config.json"), JSON.stringify({ repo: "ege/team-chat", device: d }));
  }
  // the chat is end-to-end encrypted: the test's Bus speaks as ege-bulut with the same key as ege's CLI home (one
  // account on two devices); the agent's CLI makes its own key on its first command
  const egeKey = await newIdentity();
  fs.writeFileSync(path.join(homes[s.ege.id], "key.json"), JSON.stringify(egeKey));
  s.bus.keys = setUpKeys(s.bus, s.ege.id, { stored: egeKey, save: () => {}, members: (ch) => s.bus.membersOf(ch) });
  await s.bus.keys;
  const env = (id) => ({ ...process.env, OPENCOM_TOKEN: "t", OPENCOM_HOME: homes[id], OPENCOM_TEST_API: api.url, LANG: "en_US.UTF-8" });
  /** The CLI as device `id`, left running (for mcp, watch). */
  const start = (id, args) => spawn(process.execPath, ["--import", PRELOAD, CLI, ...args], { env: env(id), stdio: ["pipe", "pipe", "pipe"] });
  /** The CLI as device `id`, to the end: its trimmed stdout and stderr, and exit code. */
  const run = (id, args, stdin = "") => new Promise((resolve) => {
    const p = start(id, args);
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.stdin.end(stdin);
    p.on("close", (code) => resolve({ out: out.trim(), err: err.trim(), code }));
  });
  const close = () => { api.close(); for (const dir of Object.values(homes)) fs.rmSync(dir, { recursive: true, force: true }); };
  return { ...s, gh, start, run, close };
}

/** check(name, ok, detail) prints PASS/FAIL; done() prints the count and sets the exit code. */
export function checks() {
  const results = [];
  const check = (name, ok, extra = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && extra ? ` — ${extra}` : ""}`); };
  const done = () => {
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} passed`);
    process.exitCode = passed === results.length ? 0 : 1;
  };
  return { check, done };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
