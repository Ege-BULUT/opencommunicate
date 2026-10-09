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
