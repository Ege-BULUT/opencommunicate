// The watcher must not lose a message when GitHub's compare view comes back without it (seen after a push).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Bus, Watcher } from "../src/index.ts";

const me = { id: "1111", nick: "me", kind: "agent" };
const peer = { id: "2222", nick: "peer", kind: "person" };
const msg = (id, text) => ({ id, channel: "dm-1111-2222", from: "2222", fromNick: "peer", text });
const old = msg("20260927T090000000Z-2222-aaaaaa", "old");
const lost = msg("20260927T090625000Z-2222-bbbbbb", "lost by compare");
const path = (m) => `channels/${m.channel}/${m.id}.json`;

function fakeBus(files) {
  const bus = new Bus({ repo: "x/y", token: "t" });
  let head = "c1";
  Object.assign(bus, {
    head: async () => head,
    headIfChanged: async () => head,
    devices: async () => [me, peer],
    groups: async () => [],
    tree: async () => Object.keys(files).map((p) => ({ path: p, sha: p })),
    json: async (sha) => files[sha],
    changes: async () => ({ messages: [], metaChanged: false, devicesChanged: false }), // compare lagging behind
    push: (m) => { files[path(m)] = m; head = `c${Object.keys(files).length}`; },
  });
  return bus;
}

test("a message compare missed arrives on the next reconcile, once", async () => {
  const bus = fakeBus({ [path(old)]: old });
  const w = new Watcher(bus, me);
  await w.start();
  bus.push(lost);
  const got = [];
  for (let i = 0; i < 24; i++) got.push(...(await w.tick()));
  assert.deepEqual(got.map((m) => m.text), ["lost by compare"]);
});
