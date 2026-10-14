// Pinned messages: private to an account and shared by its devices, newest first, no duplicates, and no commit when nothing changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, Watcher } from "../src/index.ts";

const ch = "dm-1111-2222";
const a = { channel: ch, id: "20261013T080000000Z-2222-aaaaaa" };
const b = { channel: "all", id: "20261013T080500000Z-2222-bbbbbb" };

/** A bus whose "pins" branch is one stored file; counts commits and the branch they went to. */
function fakeBus() {
  const bus = new Bus({ repo: "x/y", token: "t" });
  const state = { stored: null, commits: 0, branch: "" };
  Object.assign(bus, {
    pins: async (me) => (state.stored && me === "1111" ? state.stored : []),
    commit: async (files, _msg, opts) => {
      const out = await files(state.stored ? "c1" : null);
      assert.deepEqual(Object.keys(out), ["pins/1111.json"], "a device writes only its own file");
      state.stored = JSON.parse(out["pins/1111.json"]).pins;
      state.commits++; state.branch = opts.branch;
      return "c";
    },
  });
  return { bus, state };
}

test("pin, pin again, unpin", async () => {
  const { bus, state } = fakeBus();
  const me = { id: "1111", nick: "me" };
  let pins = await bus.setPins(me, [a], true);
  assert.deepEqual(pins.map((p) => p.id), [a.id]);
  assert.equal(state.branch, "pins", "pins live on their own branch, not main");
  pins = await bus.setPins(me, [b, b], true);
  assert.deepEqual(pins.map((p) => p.id), [b.id, a.id], "newest first, a duplicate in one call counts once");
  assert.equal(state.commits, 2);
  pins = await bus.setPins(me, [a], true);
  assert.equal(state.commits, 2, "pinning a pinned message makes no commit");
  assert.deepEqual(pins.map((p) => p.id), [b.id, a.id], "and returns the pins as they are");
  pins = await bus.setPins(me, [a], false);
  assert.deepEqual(pins.map((p) => p.id), [b.id]);
  pins = await bus.setPins(me, [a], false);
  assert.equal(state.commits, 3, "unpinning a message that is not pinned makes no commit");
  assert.equal(pins[0].channel, "all");
  assert.ok(Date.parse(pins[0].at), "each pin records when it was made");
});

test("the same id in another channel is another pin", async () => {
  const { bus } = fakeBus();
  const me = { id: "1111", nick: "me" };
  const pins = await bus.setPins(me, [a, { channel: "all", id: a.id }], true);
  assert.equal(pins.length, 2);
});

test("message() refuses paths that are not a channel and a message id", async () => {
  const bus = new Bus({ repo: "x/y", token: "t" });
  let asked = 0;
  Object.assign(bus, { readJson: async () => { asked++; return null; } });
  assert.equal(await bus.message("../auth", "1111"), null);
  assert.equal(await bus.message("all", "../../auth/1111"), null);
  assert.equal(asked, 0);
  await bus.message(ch, a.id);
  assert.equal(asked, 1);
});

test("a pin made on the phone reaches the desktop signed in as the same account", async () => {
  // one repository: the "pins" branch head moves on every commit; headIfChanged answers 304 (null) while it has not
  const repo = { head: null, files: {} };
  const device = (seen = { head: undefined }) => {
    const bus = new Bus({ repo: "x/y", token: "t" });
    Object.assign(bus, {
      headIfChanged: async (branch) => { assert.equal(branch, "pins"); if (repo.head === seen.head) return null; seen.head = repo.head; return repo.head; },
      pins: async (me, at) => { assert.equal(at, repo.head, "read at the head just seen"); return repo.files[me] ?? []; },
      commit: async (files) => {
        const out = await files(repo.head);
        for (const [path, text] of Object.entries(out)) repo.files[path.slice(5, -5)] = JSON.parse(text).pins;
        repo.head = `c${Object.keys(repo.files).length}-${Date.now()}-${Math.random()}`;
        return repo.head;
      },
    });
    return bus;
  };
  const me = { id: "1111", nick: "me", kind: "person", joinedAt: "" };
  const phone = device(), desktop = new Watcher(device(), me), stranger = new Watcher(device(), { ...me, id: "2222" });
  await phone.setPins(me, [a], true);
  assert.equal(await desktop.tickPins(), true);
  assert.deepEqual(desktop.pins.map((p) => p.id), [a.id]);
  assert.equal(await desktop.tickPins(), false, "nothing to read while the branch has not moved");
  assert.equal(await stranger.tickPins(), true);
  assert.deepEqual(stranger.pins, [], "another account does not see them");
  await phone.setPins(me, [a], false);
  assert.equal(await desktop.tickPins(), true);
  assert.deepEqual(desktop.pins, [], "an unpin reaches it too");
});
