// Read receipts: the ticks a sender sees, and a device's receipts only ever moving forward.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, newestByChannel, recipientsOf, ticksFor } from "../src/index.ts";

const ch = "dm-1111-2222";
const m1 = { id: "20261009T080000000Z-1111-aaaaaa", channel: ch };
const m2 = { id: "20261009T080500000Z-1111-bbbbbb", channel: ch };

test("one tick, two ticks, two blue ticks", () => {
  assert.equal(ticksFor(m1, ["2222"], {}), "sent");
  assert.equal(ticksFor(m1, ["2222"], { 2222: { [ch]: { delivered: m1.id } } }), "delivered");
  assert.equal(ticksFor(m1, ["2222"], { 2222: { [ch]: { delivered: m2.id, read: m1.id } } }), "read");
  // a later receipt covers earlier messages, an earlier one does not cover later messages
  assert.equal(ticksFor(m2, ["2222"], { 2222: { [ch]: { delivered: m2.id, read: m1.id } } }), "delivered");
  // read receipts off on this device: no blue for anyone
  assert.equal(ticksFor(m1, ["2222"], { 2222: { [ch]: { read: m1.id } } }, false), "delivered");
});

test("a group needs every member for two ticks", () => {
  const g = { channel: "g-team-abcd", name: "Team", members: ["1111", "2222", "3333"], createdBy: "1111", createdAt: "" };
  const to = recipientsOf(g.channel, "1111", [], [g]);
  assert.deepEqual(to, ["2222", "3333"]);
  const m = { id: m1.id, channel: g.channel };
  assert.equal(ticksFor(m, to, { 2222: { [g.channel]: { read: m.id } } }), "sent");
  assert.equal(ticksFor(m, to, { 2222: { [g.channel]: { read: m.id } }, 3333: { [g.channel]: { delivered: m.id } } }), "delivered");
  assert.deepEqual(recipientsOf("all", "1111", [{ id: "1111" }, { id: "4444" }], []), ["4444"]);
  assert.deepEqual(recipientsOf(ch, "1111", [], []), ["2222"]);
});

test("newest message per channel", () => {
  assert.deepEqual(newestByChannel([m2, m1, { id: "20261009T070000000Z-2222-cccccc", channel: "all" }]), { [ch]: m2.id, all: "20261009T070000000Z-2222-cccccc" });
});

test("receipts move forward only, and an unchanged mark makes no commit", async () => {
  const bus = new Bus({ repo: "x/y", token: "t" });
  let stored = null, commits = 0;
  Object.assign(bus, {
    receipts: async () => (stored ? { 1111: stored } : {}),
    commit: async (files) => { const out = await files(stored ? "c1" : null); stored = JSON.parse(Object.values(out)[0]).channels; commits++; return "c"; },
  });
  const me = { id: "1111", nick: "me" };
  assert.equal(await bus.markReceipts(me, { [ch]: { read: m2.id } }), true);
  assert.deepEqual(stored, { [ch]: { delivered: m2.id, read: m2.id } }, "read implies delivered");
  assert.equal(await bus.markReceipts(me, { [ch]: { delivered: m1.id, read: m1.id } }), false, "an older id never moves it back");
  assert.equal(commits, 1);
  assert.equal(await bus.markReceipts(me, { all: { delivered: m1.id } }), true);
  assert.deepEqual(stored, { [ch]: { delivered: m2.id, read: m2.id }, all: { delivered: m1.id } });
});

// Forward: author hidden, someone else's message flagged, my own not; file refs reused, one commit.
import { Bus as Bus2 } from "../src/index.ts";
test("forward flags others' messages and reuses file refs in one commit", async () => {
  const bus = new Bus2({ repo: "x/y", token: "t" });
  let commits = 0, written = {};
  Object.assign(bus, { commit: async (files) => { commits++; Object.assign(written, files); return "c"; } });
  const me = { id: "1111", nick: "me", kind: "agent" };
  const mine = { v: 1, id: "a", channel: "dm-1111-2222", from: "1111", fromNick: "me", ts: "t", text: "benim" };
  const theirs = { v: 1, id: "b", channel: "dm-1111-2222", from: "2222", fromNick: "peer", ts: "t", text: "onun", files: [{ name: "x.png", path: "channels/dm-1111-2222/files/b-x.png", size: 5 }] };
  const out = await bus.forward("all", me, [mine, theirs]);
  assert.equal(commits, 1, "one commit for the batch");
  assert.equal(out[0].forwarded, undefined, "my own message is not flagged");
  assert.equal(out[1].forwarded, true, "someone else's is flagged");
  assert.equal(out[0].from, "1111"); assert.equal(out[1].from, "1111", "forwarder is the sender");
  assert.deepEqual(out[1].files, theirs.files, "file refs copied, not re-uploaded");
  assert.equal(Object.keys(written).length, 2, "two message files");
});
