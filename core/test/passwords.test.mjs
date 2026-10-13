// Passwords: hashes verify only the right password; a claim gives an existing device back with the right
// password, or to its own GitHub account when it has none; the record lives apart from the device file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, ClaimError, hashPassword, verifyPassword } from "../src/index.ts";

const ege = { id: "7779", nick: "ege-bulut", kind: "phone", login: "Ege-BULUT", joinedAt: "2026-01-01T00:00:00.000Z" };

/** A bus whose repo is a map of files: commits merge into it, contents and tree reads come from it. */
function world(devices = [ege]) {
  const files = Object.fromEntries(devices.map((d) => [`devices/${d.id}.json`, JSON.stringify(d, null, 2) + "\n"]));
  const commits = [];
  const bus = new Bus({ repo: "ege/chat", token: "t", fetch: async (url) => {
    const path = url.match(/\/contents\/(.+)\?ref=h$/)?.[1];
    if (path && path in files) return new Response(JSON.stringify({ content: Buffer.from(files[path]).toString("base64") }));
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  } });
  bus.commit = async (f) => { commits.push(f); Object.assign(files, f); return "sha"; };
  bus.head = async () => "h";
  bus.tree = async () => Object.keys(files).map((p) => ({ path: p, sha: p }));
  bus.json = async (p) => JSON.parse(files[p]);
  return { bus, files, commits };
}

const reason = (r) => (e) => e instanceof ClaimError && e.reason === r;

test("a hash verifies its own password and no other; the same salt gives the same hash", async () => {
  const salt = new Uint8Array(16).fill(7);
  const r = await hashPassword("kedi1234", salt);
  assert.equal(r.alg, "PBKDF2-SHA256");
  assert.equal(r.iter, 600000);
  assert.equal(Buffer.from(r.salt, "base64").length, 16);
  assert.equal(Buffer.from(r.hash, "base64").length, 32);
  assert.equal((await hashPassword("kedi1234", salt)).hash, r.hash);
  assert.notEqual((await hashPassword("kedi1234")).hash, r.hash, "a fresh salt each time");
  assert.equal(await verifyPassword("kedi1234", r), true);
  assert.equal(await verifyPassword("kedi1235", r), false);
  assert.equal(await verifyPassword("", r), false);
});

test("setPassword writes auth/<id>.json only; the device file stays as it was; devices() skips auth/", async () => {
  const w = world();
  const before = w.files["devices/7779.json"];
  await assert.rejects(w.bus.setPassword(ege, "12345"), /at least 6/);
  await w.bus.setPassword(ege, "kedi1234");
  assert.deepEqual(Object.keys(w.commits.at(-1)), ["auth/7779.json"]);
  assert.equal(w.files["devices/7779.json"], before);
  assert.equal(await verifyPassword("kedi1234", JSON.parse(w.files["auth/7779.json"])), true);
  assert.deepEqual(await w.bus.passwordRecord("7779"), JSON.parse(w.files["auth/7779.json"]));
  assert.deepEqual((await w.bus.devices()).map((d) => d.id), ["7779"]);
});

test("the right password gives the device back, from another GitHub account too, and records the new login", async () => {
  const w = world();
  await w.bus.setPassword(ege, "kedi1234");
  const { device, needsPassword } = await w.bus.claim({ handle: "Ege-Bulut #7779", password: "kedi1234", login: "someone", kind: "desktop" });
  assert.equal(needsPassword, false);
  assert.equal(device.id, "7779");
  assert.equal(device.joinedAt, ege.joinedAt);
  assert.deepEqual(JSON.parse(w.files["devices/7779.json"]), { ...ege, login: "someone", kind: "desktop" });
  // same login and kind: nothing to write
  const n = w.commits.length;
  await w.bus.claim({ handle: "ege-bulut#7779", password: "kedi1234", login: "someone", kind: "desktop" });
  assert.equal(w.commits.length, n);
});

test("a wrong password, an unknown id, another nick or a bad handle is refused, and nothing is written", async () => {
  const w = world();
  await w.bus.setPassword(ege, "kedi1234");
  const n = w.commits.length;
  const claim = (handle, password = "kedi1234") => w.bus.claim({ handle, password, login: "Ege-BULUT", kind: "phone" });
  await assert.rejects(claim("ege-bulut#7779", "kedi12345"), reason("password"));
  await assert.rejects(claim("ege-bulut#5531"), reason("unknown"));
  await assert.rejects(claim("ege#7779"), reason("unknown"));
  await assert.rejects(claim("ege-bulut"), reason("format"));
  await assert.rejects(claim("ege-bulut#77"), reason("format"));
  assert.equal(w.commits.length, n);
});

test("a device without a password: its own GitHub login gets it back and is asked for one; another login is refused", async () => {
  const w = world();
  const mine = await w.bus.claim({ handle: "ege-bulut#7779", password: "", login: "ege-bulut", kind: "phone" });
  assert.equal(mine.needsPassword, true);
  assert.equal(mine.device.id, "7779");
  await assert.rejects(w.bus.claim({ handle: "ege-bulut#7779", password: "anything", login: "mallory", kind: "phone" }), reason("login"));
  assert.equal(JSON.parse(w.files["devices/7779.json"]).login, "ege-bulut");
  assert.equal(w.files["auth/7779.json"], undefined);
});

test("a record with a round count far past ours is refused without hashing", async () => {
  const r = await hashPassword("kedi1234");
  const started = Date.now();
  assert.equal(await verifyPassword("kedi1234", { ...r, iter: 1_000_000_000 }), false);
  assert.ok(Date.now() - started < 1000);
});
