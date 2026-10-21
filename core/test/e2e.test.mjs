// End-to-end encryption against the in-memory GitHub: what the repository holds is sealed, members open it, others
// don't; a member added later reads the history, one who left reads nothing after; another device of the same
// account unlocks the key with the password.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, dmChannel, msgPath } from "../src/index.ts";
import { SEALED_TEXT, setUpKeys } from "../src/e2e.ts";
import { fakeGitHub } from "../../test/fakegh.mjs";

const person = (id, nick) => ({ id, nick, kind: "person", login: nick, joinedAt: "2026-10-01T00:00:00.000Z" });
const ege = person("7779", "ege"), ada = person("1111", "ada"), bob = person("2222", "bob");

async function world() {
  const gh = fakeGitHub();
  const plain = new Bus({ repo: "x/chat", token: "t", fetch: gh.fetch });
  await plain.commit({ "opencommunicate.json": "{}", "channels/all/.keep": "", ...Object.fromEntries([ege, ada, bob].map((d) => [`devices/${d.id}.json`, JSON.stringify(d)])) }, "setup");
  /** A device of `who`: a Bus with keys (stored: a key it already has; password: what it answers when asked). */
  const device = async (who, { stored = null, password = null } = {}) => {
    const bus = new Bus({ repo: "x/chat", token: "t", fetch: gh.fetch });
    let saved = stored;
    bus.keys = setUpKeys(bus, who.id, { stored, save: (id) => (saved = id), password: async () => password, members: (ch) => bus.membersOf(ch) });
    await bus.keys;
    return { bus, key: () => saved };
  };
  const raw = (path, branch = "main") => JSON.parse(gh.files(branch)[path]);
  return { gh, plain, device, raw };
}

test("a DM is sealed in the repository and opened by both ends only", async () => {
  const { plain, device, raw, gh } = await world();
  const e = await device(ege, { password: "ege's password" }), a = await device(ada);
  const dm = dmChannel(ege.id, ada.id);
  const sent = await e.bus.send(dm, ege, "the deploy key is in the vault", [{ name: "notes.txt", data: new TextEncoder().encode("secret notes") }]);
  const stored = raw(msgPath(sent));
  assert.equal(stored.text, SEALED_TEXT, "older apps see a placeholder");
  assert.ok(stored.enc && !stored.files, "text and files are sealed");
  assert.ok(!JSON.stringify(gh.files()).includes("vault") && !JSON.stringify(gh.files()).includes("notes.txt"), "neither words nor file names in the repository");
  assert.equal(sent.text, "the deploy key is in the vault", "the sender gets it back open");
  const [got] = await a.bus.history(dm);
  assert.equal(got.text, "the deploy key is in the vault");
  assert.equal(new TextDecoder().decode(await a.bus.fileOf(got.files[0])), "secret notes");
  assert.notEqual(new TextDecoder().decode(await plain.file(got.files[0].path)), "secret notes", "the file's bytes are sealed too");
  const b = await device(bob);
  const [seen] = await b.bus.history(dm);
  assert.ok(seen.locked && seen.text === SEALED_TEXT, "someone outside the DM can't open it");
  const [old] = await plain.history(dm);
  assert.ok(old.locked, "nor can a client with no keys");
  assert.ok(raw("keys/7779.json", "keys").backup && !raw("keys/1111.json", "keys").backup, "a person with a password keeps a locked copy; without one, none");
});

test("a member added later reads the history; one who left reads nothing after", async () => {
  const { device } = await world();
  const e = await device(ege), a = await device(ada), b = await device(bob);
  const g = await e.bus.createGroup("Team", [ada.id], ege);
  const before = await e.bus.send(g.channel, ege, "before bob");
  await e.bus.changeGroup(g.channel, { type: "add", ids: [bob.id] }, ege);
  assert.ok((await b.bus.history(g.channel)).find((m) => m.id === before.id)?.locked, "not yet: no one has sent since");
  await a.bus.send(g.channel, ada, "welcome bob");
  const bobSees = (await b.bus.history(g.channel)).filter((m) => !m.system).map((m) => m.text);
  assert.deepEqual(bobSees, ["before bob", "welcome bob"], "the next sender shared every epoch with him");
  await e.bus.changeGroup(g.channel, { type: "remove", id: bob.id }, ege);
  await e.bus.send(g.channel, ege, "after bob left");
  const last = (await b.bus.history(g.channel)).filter((m) => !m.system).at(-1);
  assert.ok(last.locked, "a new epoch without him");
  assert.equal((await a.bus.history(g.channel)).filter((m) => !m.system).at(-1).text, "after bob left");
});

test("edits stay sealed, their notice says no words; a delete drops the seal", async () => {
  const { device, raw } = await world();
  const e = await device(ege), a = await device(ada);
  const dm = dmChannel(ege.id, ada.id);
  const m = await e.bus.send(dm, ege, "draft plan");
  const { message, notice } = await e.bus.amend(ege, m, "final plan");
  assert.equal(raw(msgPath(m)).text, SEALED_TEXT);
  assert.equal(notice.text, "ege#7779 edited a message", "the notice carries no text");
  const got = await a.bus.message(dm, m.id);
  assert.equal(got.text, "final plan");
  assert.deepEqual(got.edits.map((x) => x.text), ["draft plan"]);
  assert.equal(message.text, "final plan");
  await e.bus.amend(ege, m, null);
  const gone = raw(msgPath(m));
  assert.ok(gone.deleted && !gone.enc && gone.text === "");
});

test("drafts and the status line are sealed too", async () => {
  const { device, raw, gh } = await world();
  const e = await device(ege), a = await device(ada);
  await e.bus.setDrafts(ege, { all: "half a thought about the merger" });
  assert.ok(!gh.files("drafts")["drafts/7779.json"].includes("merger"));
  assert.equal((await e.bus.drafts(ege.id)).all.text, "half a thought about the merger");
  await e.bus.heartbeat(ege, "reviewing the merger");
  assert.ok(!gh.files("presence")["presence/7779.json"].includes("merger"));
  assert.equal((await a.bus.presence())[ege.id].status, "reviewing the merger");
  void raw;
});

test("another device of the account unlocks the key with the password, not without it", async () => {
  const { device } = await world();
  const first = await device(ege, { password: "correct horse" }), a = await device(ada);
  const dm = dmChannel(ege.id, ada.id);
  await a.bus.send(dm, ada, "for both your devices");
  const second = await device(ege, { password: "correct horse" });
  assert.equal((await second.bus.history(dm))[0].text, "for both your devices");
  assert.equal(second.key().priv, first.key().priv, "the same key, from its locked copy");
  const gh2 = fakeGitHub(); void gh2;
  const locked = new Bus({ repo: "x/chat", token: "t", fetch: a.bus["f"] });
  let asked = 0;
  locked.keys = setUpKeys(locked, ege.id, { stored: null, save: () => {}, password: async () => (asked++ < 2 ? "wrong" : null), members: (ch) => locked.membersOf(ch) });
  assert.equal(await locked.keys, null, "wrong passwords, then giving up: locked");
  assert.equal(asked, 3);
  await assert.rejects(locked.send(dm, ege, "x"), /locked/);
});

test("someone who makes a key later reads what was sent before: whoever holds the chat's key shares it", async () => {
  const { device } = await world();
  const a = await device(ada);
  const dm = dmChannel(ege.id, ada.id);
  const early = await a.bus.send(dm, ada, "sent before ege updated");
  const e = await device(ege); // publishes ege's key now
  assert.ok((await e.bus.message(dm, early.id)).locked, "not yet");
  await (await a.bus.keys).sync(); // ada's app or watch looks at the keys on its next poll
  for (let i = 0; i < 50 && (await e.bus.message(dm, early.id)).locked; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal((await e.bus.message(dm, early.id)).text, "sent before ege updated");
});

test("a device whose key is no longer the account's never publishes over it", async () => {
  const { device, raw } = await world();
  const first = await device(ege, { password: "pw" });
  const stale = { pub: (await device(bob)).key().pub, priv: (await device(bob)).key().priv }; // some other key pair
  const again = await device(ege, { stored: stale, password: "pw" });
  assert.equal(again.key().pub, first.key().pub, "it unlocked the account's key from the backup instead");
  assert.equal(raw("keys/7779.json", "keys").pub, first.key().pub);
  assert.ok(raw("keys/7779.json", "keys").backup, "and the backup is still there");
  const a = await device(ada); // no password: no backup
  const other = { pub: first.key().pub, priv: first.key().priv };
  const b2 = new Bus({ repo: "x/chat", token: "t", fetch: a.bus["f"] });
  b2.keys = setUpKeys(b2, ada.id, { stored: other, save: () => {}, members: (ch) => b2.membersOf(ch) });
  assert.equal(await b2.keys, null, "no backup to unlock: locked, not replaced");
  assert.equal(raw("keys/1111.json", "keys").pub, a.key().pub);
});

test("locked messages are not forwarded; a closed question's note is sealed; a rewritten sender does not open", async () => {
  const { device, gh, raw } = await world();
  const e = await device(ege), a = await device(ada), b = await device(bob);
  const dm = dmChannel(ege.id, ada.id);
  const m = await e.bus.send(dm, ege, "for ada only");
  const [seen] = await b.bus.history(dm);
  await assert.rejects(b.bus.forward("all", bob, [seen]), /can't open/);
  const ask = await e.bus.send(dm, ege, "Allow Bash?", [], { ask: ["Allow", "Deny"] });
  await e.bus.closeAsk(ege, ask, "answered in the terminal");
  assert.ok(!Object.values(gh.files()).some((t) => t.includes("answered in the terminal")), "neither in the question nor its notice");
  assert.equal((await a.bus.message(dm, ask.id)).closed.note, "answered in the terminal");
  const forged = { ...raw(msgPath(m)), from: ada.id, fromNick: "ada" };
  await e.bus.commit({ [msgPath(m)]: JSON.stringify(forged) }, "forge");
  assert.ok((await a.bus.message(dm, m.id)).locked, "the id says ege sent it");
});
