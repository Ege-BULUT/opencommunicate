// Pinned messages: private to a device, newest first, no duplicates, and no commit when nothing changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus } from "../src/index.ts";

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
